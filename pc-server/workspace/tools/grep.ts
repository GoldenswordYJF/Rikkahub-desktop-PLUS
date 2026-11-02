// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/grep.ts(v0.83.0)。schema/description、
// 输出格式(匹配行 path:line: text、上下文行 path-line- text)、上限与提示文案逐字保留。
// PC 适配:pi 默认 shell 出 ripgrep 二进制(ensureTool 联网下载);兜底场景(无 bash 的
// 机器)不引入外部二进制,引擎换 fs-walk 遍历器 + JS RegExp 逐行匹配。
// 引擎差异如实声明:正则方言是 JS RegExp(非 rust regex);单文件超过 maxFileBytes
// (默认 512KB,对齐 read 硬闸)与二进制文件(前 8KB 含 NUL)静默跳过。
// 挂载策略(2026-08-01):仅在 bash 不可用时挂载。

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename } from "node:path";
import { Glob } from "bun";
import { resolveToCwd } from "./path-utils";
import { walkDirectory } from "./fs-walk";
import {
  emptySearchCoverage,
  hasSearchGaps,
  noResultWithCoverage,
  searchCoverageDescriptionAppend,
  searchCoverageNotice,
  type SearchCoverage,
} from "../ops/search-coverage";
import {
  capRenderedLines,
  persistToolResult,
  RESULT_COLLECT_CAP,
  RESUME_SEARCH_DESCRIPTION_APPEND,
  searchResumeNotice,
} from "../ops/resume-truncation";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024; // 对齐 boundary.READ_HARD_LIMIT_BYTES
const BINARY_SNIFF_BYTES = 8192;

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  visitCapReached?: boolean;
  /** S5:覆盖计数(仅开关开启且存在缺口时出现;旧字段名与语义不变)。 */
  coverage?: SearchCoverage;
  /** S6:完整结果落盘路径(仅开关开启且命中上限/截断时出现)。 */
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the grep tool.
 * PC:边界校验层从这里注入。
 */
export interface GrepOperations {
  /** Check if path is a directory. Throws if path does not exist. */
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  /** Read file contents (binary; engine decodes) */
  readFile: (absolutePath: string) => Promise<Buffer> | Buffer;
  /** File size in bytes (oversized files are skipped, not read) */
  statSize: (absolutePath: string) => Promise<number> | number;
}

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (p) => (await fsStat(p)).isDirectory(),
  readFile: (p) => fsReadFile(p),
  statSize: async (p) => (await fsStat(p)).size,
};

export interface GrepToolOptions {
  /** Custom operations for grep. Default: local filesystem */
  operations?: GrepOperations;
  /** 单文件体积上限(超过静默跳过)。Default: 512KB */
  maxFileBytes?: number;
  /** S5:覆盖可见化开关(默认关 → 输出与历史逐字一致;开启才采集计数并追加说明)。 */
  coverageHonesty?: boolean;
  /** S6:命中上限时把收集到的完整结果落盘并给出续读路径(默认关 → 历史行为)。 */
  resumeTruncatedOutput?: boolean;
  /** S6 落盘目录(工作区 tmp/)。resumeTruncatedOutput 开启时生效。 */
  tempFileDir?: string;
}

const GREP_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: { type: "string", description: "Directory or file to search (default: current directory)" },
    glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
    literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
    context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
    limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
  },
  required: ["pattern"],
} as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// rg --glob 语义近似:不含 / 的按 basename 任意深度过滤;含 / 的按相对路径。
// 全路径模式同时保留原样与补通配前缀两个 glob(不同实现对 `**` 匹配零层目录的
// 语义有分歧,任一命中即命中)。
function compileGlobFilter(glob: string): { globs: Glob[]; fullPath: boolean } {
  if (glob.includes("/")) {
    const effective = glob.startsWith("/") ? glob.slice(1) : glob;
    const variants = [effective];
    if (!effective.startsWith("**/") && effective !== "**") variants.push(`**/${effective}`);
    return { globs: variants.map((v) => new Glob(v)), fullPath: true };
  }
  return { globs: [new Glob(glob)], fullPath: false };
}

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

interface GrepMatch {
  relativePath: string;
  lineNumber: number;
  /** 全文件行数组(上下文渲染用;同文件共享同一引用) */
  lines: string[];
}

export function createGrepTool(
  cwd: string,
  options?: GrepToolOptions,
): WorkspaceToolDefinition<GrepToolInput, GrepToolDetails | undefined> {
  const ops = options?.operations ?? defaultGrepOperations;
  const maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const coverageHonesty = options?.coverageHonesty === true;
  const resumeOutput = options?.resumeTruncatedOutput === true;
  const tempFileDir = options?.tempFileDir;
  const coverageOptions = {
    noun: "file" as const,
    // 用实际生效的单文件上限(测试/自定义 maxFileBytes 时标签仍然诚实)。
    sizeLabel: formatSize(maxFileBytes).replace(".0KB", "KB"),
  };
  return {
    name: "grep",
    description:
      `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`
      + (coverageHonesty ? searchCoverageDescriptionAppend("file") : "")
      + (resumeOutput ? RESUME_SEARCH_DESCRIPTION_APPEND : ""),
    parameters: GREP_SCHEMA as unknown as Record<string, unknown>,
    async execute({ pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, signal?) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      let isDirectory: boolean;
      try {
        isDirectory = await ops.isDirectory(searchPath);
      } catch (e: any) {
        // 仅文件系统"不存在"映射为 Path not found;边界错误等其他异常原样透传
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw new Error(`Path not found: ${searchPath}`);
        throw e;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
      } catch (e: any) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }
      const globFilter = glob ? compileGlobFilter(glob) : null;
      const contextValue = context && context > 0 ? Math.floor(context) : 0;
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

      let matchCount = 0;
      let matchLimitReached = false;
      let collectionCapReached = false;
      let linesTruncated = false;
      const matches: GrepMatch[] = [];
      const coverage = emptySearchCoverage();
      // S6:开启续读时,显示上限之外继续收集到安全帽,落盘文件才有续读价值;
      // 关闭时收集上限 = 显示上限,行为与历史逐字一致。
      const collectLimit = resumeOutput ? Math.max(effectiveLimit, RESULT_COLLECT_CAP) : effectiveLimit;

      const searchFile = async (absolutePath: string, relativePath: string): Promise<boolean> => {
        throwIfAborted();
        try {
          const size = await ops.statSize(absolutePath);
          if (size > maxFileBytes) {
            coverage.oversized++;
            return true;
          }
          const buffer = await ops.readFile(absolutePath);
          if (looksBinary(buffer)) {
            coverage.binary++;
            return true;
          }
          coverage.scanned++;
          const lines = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue;
            matchCount++;
            matches.push({ relativePath, lineNumber: i + 1, lines });
            if (matchCount >= effectiveLimit) matchLimitReached = true;
            if (matchCount >= collectLimit) {
              collectionCapReached = true;
              return false;
            }
          }
        } catch {
          // 不可读文件跳过,不让单点故障终止全局搜索
          coverage.unreadable++;
        }
        return true;
      };

      let visitCapReached = false;
      if (!isDirectory) {
        await searchFile(searchPath, basename(searchPath));
      } else {
        // 同步遍历器 + 异步文件读取:先收集候选文件,再逐个搜索(遍历器有 maxVisited 安全罩)
        const candidates: Array<{ absolutePath: string; relativePath: string }> = [];
        const walk = walkDirectory(searchPath, {
          signal,
          onEntry({ absolutePath, relativePath }) {
            if (globFilter) {
              const target = globFilter.fullPath ? relativePath : (relativePath.split("/").pop() ?? relativePath);
              if (!globFilter.globs.some((g) => g.match(target))) return;
            }
            candidates.push({ absolutePath, relativePath });
          },
        });
        visitCapReached = walk.visitCapReached;
        coverage.visitCapReached = visitCapReached;
        coverage.unreadable += walk.unreadableDirs;
        for (const candidate of candidates) {
          if (!(await searchFile(candidate.absolutePath, candidate.relativePath))) break;
        }
      }
      throwIfAborted();

      if (matchCount === 0) {
        // S5:有缺口时"没找到"不等于"不存在"——补覆盖说明,不再给总数断言。
        const text = coverageHonesty
          ? noResultWithCoverage("No matches found", coverage, coverageOptions)
          : "No matches found";
        return {
          content: [{ type: "text", text }],
          details: coverageHonesty && hasSearchGaps(coverage) ? { coverage } : undefined,
        };
      }

      // 输出格式与 pi 逐字一致:匹配行 path:line: text;上下文行 path-line- text
      // 落盘文件用完整行文本(forFile=true 不截断长行),展示走 truncateLine。
      const renderMatchLines = (list: GrepMatch[], forFile: boolean): { lines: string[]; hitLineTruncation: boolean } => {
        const outputLines: string[] = [];
        let hitTruncation = false;
        for (const match of list) {
          const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
          const end = contextValue > 0 ? Math.min(match.lines.length, match.lineNumber + contextValue) : match.lineNumber;
          for (let current = start; current <= end; current++) {
            const lineText = match.lines[current - 1] ?? "";
            let renderedText = lineText;
            if (!forFile) {
              const rendered = truncateLine(lineText);
              renderedText = rendered.text;
              if (rendered.wasTruncated) hitTruncation = true;
            }
            if (current === match.lineNumber) outputLines.push(`${match.relativePath}:${current}: ${renderedText}`);
            else outputLines.push(`${match.relativePath}-${current}- ${renderedText}`);
          }
        }
        return { lines: outputLines, hitLineTruncation: hitTruncation };
      };

      const displayRendered = renderMatchLines(matches.slice(0, effectiveLimit), false);
      linesTruncated = displayRendered.hitLineTruncation;
      const rawOutput = displayRendered.lines.join("\n");
      // Apply byte truncation. There is no line limit here because the match limit already capped rows.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
          + (coverageHonesty ? ` Searched ${coverage.scanned} files before the limit.` : ""),
        );
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      // S6:命中显示上限/字节截断时,把本轮收集到的完整结果落盘并给续读路径。
      if (resumeOutput && tempFileDir && (matchLimitReached || truncation.truncated) && matches.length > 0) {
        const fileRendered = capRenderedLines(renderMatchLines(matches, true).lines);
        const persisted = await persistToolResult({ tempFileDir, prefix: "pi-grep", lines: fileRendered.lines });
        if (persisted) {
          notices.push(
            searchResumeNotice(persisted, {
              noun: "match",
              capReached: collectionCapReached || fileRendered.capReached,
            }),
          );
          details.fullOutputPath = persisted.path;
        }
      }
      if (visitCapReached) {
        details.visitCapReached = true;
        // S5 开启时覆盖说明已包含"遍历安全罩截断";关闭时保持原文案(且仍按旧规则
        // 在命中上限时不重复提示)。
        if (!matchLimitReached && !coverageHonesty) {
          notices.push("Directory tree too large, search stopped early. Narrow the path argument");
        }
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (coverageHonesty) {
        const coverageNotice = searchCoverageNotice(coverage, coverageOptions);
        if (coverageNotice) {
          output += `\n\n${coverageNotice}`;
          details.coverage = coverage;
        }
      }
      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
