// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/ls.ts(v0.83.0)。schema/description/execute
// 逐字保留(排序、目录尾 /、条目上限与截断提示文案);TUI 渲染弃用,TypeBox → OpenAI JSON Schema。
// 挂载策略(2026-08-01):仅在 bash 不可用时作为兜底挂载(pi 默认也不挂,bash 在手时
// ls 职责由 bash 承担,避免稀释工具面)。

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import { pathExists, resolveToCwd } from "./path-utils";
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
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

export interface LsToolInput {
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
  /** S5:覆盖计数(仅开关开启且存在缺口时出现;旧字段名与语义不变)。 */
  coverage?: SearchCoverage;
  /** S6:完整结果落盘路径(仅开关开启且命中上限/截断时出现)。 */
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the ls tool.
 * PC:边界校验层从这里注入。
 */
export interface LsOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Get file or directory stats. Throws if not found. */
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries */
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: fsStat,
  readdir: (path) => fsReaddir(path),
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
  /** S5:覆盖可见化开关(默认关 → 输出与历史逐字一致;开启才采集计数并追加说明)。 */
  coverageHonesty?: boolean;
  /** S6:命中上限时把完整条目列表落盘并给出续读路径(默认关 → 历史行为)。 */
  resumeTruncatedOutput?: boolean;
  /** S6 落盘目录(工作区 tmp/)。resumeTruncatedOutput 开启时生效。 */
  tempFileDir?: string;
}

// 与 pi 原版逐字一致:无必填参数时不写 required 键(TypeBox 同样省略;
// P3 契约对照测试按语义全等钉住,required:[] 与缺省虽等价,但移植逐字纪律优先)。
const LS_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list (default: current directory)" },
    limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
  },
} as const;

export function createLsTool(
  cwd: string,
  options?: LsToolOptions,
): WorkspaceToolDefinition<LsToolInput, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  const coverageHonesty = options?.coverageHonesty === true;
  const resumeOutput = options?.resumeTruncatedOutput === true;
  const tempFileDir = options?.tempFileDir;
  const coverageOptions = { noun: "entry" as const, sizeLabel: `${DEFAULT_MAX_BYTES / 1024}KB` };
  return {
    name: "ls",
    description:
      `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`
      + (coverageHonesty ? searchCoverageDescriptionAppend("entry") : "")
      + (resumeOutput ? RESUME_SEARCH_DESCRIPTION_APPEND : ""),
    parameters: LS_SCHEMA as unknown as Record<string, unknown>,
    async execute({ path, limit }, signal?) {
      const throwIfAborted = (): void => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();

      const dirPath = resolveToCwd(path || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      if (!(await ops.exists(dirPath))) {
        throw new Error(`Path not found: ${dirPath}`);
      }
      const stat = await ops.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      let entries: string[];
      try {
        entries = [...(await ops.readdir(dirPath))];
      } catch (e: any) {
        throw new Error(`Cannot read directory: ${e.message}`);
      }
      throwIfAborted();

      // Sort alphabetically, case-insensitive.
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Format entries with directory indicators.
      const results: string[] = [];
      const coverage = emptySearchCoverage();
      let entryLimitReached = false;
      let collectionCapReached = false;
      // S6:开启续读时显示上限之外继续收集到安全帽(落盘文件才有完整内容);
      // 关闭时收集上限 = 显示上限,行为与历史逐字一致。
      const collectLimit = resumeOutput ? Math.max(effectiveLimit, RESULT_COLLECT_CAP) : effectiveLimit;
      for (const entry of entries) {
        if (!resumeOutput) {
          if (results.length >= effectiveLimit) {
            entryLimitReached = true;
            break;
          }
        } else if (results.length >= collectLimit) {
          collectionCapReached = true;
          break;
        }
        const fullPath = nodePath.join(dirPath, entry);
        let suffix = "";
        try {
          const entryStat = await ops.stat(fullPath);
          if (entryStat.isDirectory()) suffix = "/";
        } catch {
          // Skip entries we cannot stat.
          coverage.unreadable++;
          continue;
        }
        coverage.scanned++;
        results.push(entry + suffix);
      }
      // 续读模式:收集数超过显示上限即为"列表被截断"。
      if (resumeOutput && results.length > effectiveLimit) entryLimitReached = true;
      throwIfAborted();

      const displayResults = resumeOutput ? results.slice(0, effectiveLimit) : results;
      if (displayResults.length === 0) {
        // S5:有读不了的条目时不说"空目录"。
        const text = coverageHonesty
          ? noResultWithCoverage("(empty directory)", coverage, coverageOptions)
          : "(empty directory)";
        return {
          content: [{ type: "text", text }],
          details: coverageHonesty && hasSearchGaps(coverage) ? { coverage } : undefined,
        };
      }

      const rawOutput = displayResults.join("\n");
      // Apply byte truncation. There is no separate line limit because entry count is already capped.
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: LsToolDetails = {};
      // Build actionable notices for truncation and entry limits.
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`
          + (coverageHonesty ? ` Listed ${coverage.scanned} entries before the limit.` : ""),
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      // S6:命中显示上限/字节截断时,把完整条目列表落盘并给续读路径。
      if (resumeOutput && tempFileDir && (entryLimitReached || truncation.truncated) && results.length > 0) {
        const fileRendered = capRenderedLines(results);
        const persisted = await persistToolResult({ tempFileDir, prefix: "pi-ls", lines: fileRendered.lines });
        if (persisted) {
          notices.push(
            searchResumeNotice(persisted, {
              noun: "entry",
              capReached: collectionCapReached || fileRendered.capReached,
            }),
          );
          details.fullOutputPath = persisted.path;
        }
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }
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
