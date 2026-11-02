// Adapted from pi (https://github.com/badlogic/pi-mono), MIT © Mario Zechner
// 来源:packages/coding-agent/src/core/tools/find.ts(v0.83.0)。schema/description 与
// 模式语义(含 / 的模式全路径匹配并自动补 **/ 前缀,否则按 basename)逐字保留。
// PC 适配:pi 默认 shell 出 fd 二进制(ensureTool 联网下载);兜底场景(无 bash 的机器)
// 不引入外部二进制,引擎换 fs-walk 遍历器 + Bun.Glob(.gitignore 常用子集在遍历器内)。
// 挂载策略(2026-08-01):仅在 bash 不可用时挂载。

import { pathExists, resolveToCwd } from "./path-utils";
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
import { Glob } from "bun";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";
import type { WorkspaceToolDefinition } from "./types";

export interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
  visitCapReached?: boolean;
  /** S5:覆盖计数(仅开关开启且存在缺口时出现;旧字段名与语义不变)。 */
  coverage?: SearchCoverage;
  /** S6:完整结果落盘路径(仅开关开启且命中上限/截断时出现)。 */
  fullOutputPath?: string;
}

/**
 * Pluggable operations for the find tool.
 * PC:边界校验层从这里注入。
 */
export interface FindOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
}

const defaultFindOperations: FindOperations = {
  exists: pathExists,
};

export interface FindToolOptions {
  /** Custom operations for find. Default: local filesystem */
  operations?: FindOperations;
  /** S5:覆盖可见化开关(默认关 → 输出与历史逐字一致;开启才采集计数并追加说明)。 */
  coverageHonesty?: boolean;
  /** S6:命中上限时把收集到的完整结果落盘并给出续读路径(默认关 → 历史行为)。 */
  resumeTruncatedOutput?: boolean;
  /** S6 落盘目录(工作区 tmp/)。resumeTruncatedOutput 开启时生效。 */
  tempFileDir?: string;
}

const FIND_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: "Maximum number of results (default: 1000)" },
  },
  required: ["pattern"],
} as const;

// pi/fd 语义:模式含 / 时全路径匹配(缺通配前缀时自动补全);否则按 basename 任意深度匹配。
// 全路径模式保留原样与补前缀两个 glob,任一命中即命中(`**` 零层匹配语义保险)。
function compileFindPattern(pattern: string): { globs: Glob[]; fullPath: boolean } {
  if (pattern.includes("/")) {
    const effective = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    const variants = [effective];
    if (!effective.startsWith("**/") && effective !== "**") {
      variants.push(`**/${effective}`);
    }
    return { globs: variants.map((v) => new Glob(v)), fullPath: true };
  }
  return { globs: [new Glob(pattern)], fullPath: false };
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): WorkspaceToolDefinition<FindToolInput, FindToolDetails | undefined> {
  const ops = options?.operations ?? defaultFindOperations;
  const coverageHonesty = options?.coverageHonesty === true;
  const resumeOutput = options?.resumeTruncatedOutput === true;
  const tempFileDir = options?.tempFileDir;
  const coverageOptions = { noun: "entry" as const, sizeLabel: `${DEFAULT_MAX_BYTES / 1024}KB` };
  return {
    name: "find",
    description:
      `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`
      + (coverageHonesty ? searchCoverageDescriptionAppend("entry") : "")
      + (resumeOutput ? RESUME_SEARCH_DESCRIPTION_APPEND : ""),
    parameters: FIND_SCHEMA as unknown as Record<string, unknown>,
    async execute({ pattern, path: searchDir, limit }, signal?) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      if (!(await ops.exists(searchPath))) {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      // S6:开启续读时继续收集到安全帽(落盘文件才有完整内容);关闭时与历史一致。
      const collectLimit = resumeOutput ? Math.max(effectiveLimit, RESULT_COLLECT_CAP) : effectiveLimit;
      let collected = 0;
      let resultLimitReached = false;
      let collectionCapReached = false;
      let compiled: { globs: Glob[]; fullPath: boolean };
      try {
        compiled = compileFindPattern(pattern);
      } catch {
        throw new Error(`Invalid glob pattern: ${pattern}`);
      }

      const matches: string[] = [];
      const coverage = emptySearchCoverage();
      const walk = walkDirectory(searchPath, {
        signal,
        includeDirectories: true,
        onEntry({ relativePath, isDirectory }) {
          coverage.scanned++;
          const target = compiled.fullPath ? relativePath : (relativePath.split("/").pop() ?? relativePath);
          if (!compiled.globs.some((g) => g.match(target))) return;
          collected++;
          matches.push(isDirectory ? `${relativePath}/` : relativePath);
          if (collected >= effectiveLimit) resultLimitReached = true;
          if (collected >= collectLimit) {
            collectionCapReached = true;
            return false;
          }
        },
      });
      coverage.visitCapReached = walk.visitCapReached;
      coverage.unreadable = walk.unreadableDirs;

      if (matches.length === 0) {
        // S5:有缺口时不给"没有文件"的总数断言。
        const text = coverageHonesty
          ? noResultWithCoverage("No files found matching pattern", coverage, coverageOptions)
          : "No files found matching pattern";
        return {
          content: [{ type: "text", text }],
          details: coverageHonesty && hasSearchGaps(coverage) ? { coverage } : undefined,
        };
      }

      const displayMatches = matches.slice(0, effectiveLimit);
      const rawOutput = displayMatches.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let resultOutput = truncation.content;
      const details: FindToolDetails = {};
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
          + (coverageHonesty ? ` Searched ${coverage.scanned} entries before the limit.` : ""),
        );
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      // S6:命中显示上限/字节截断时,把本轮收集到的完整结果落盘并给续读路径。
      if (resumeOutput && tempFileDir && (resultLimitReached || truncation.truncated) && matches.length > 0) {
        const fileRendered = capRenderedLines(matches);
        const persisted = await persistToolResult({ tempFileDir, prefix: "pi-find", lines: fileRendered.lines });
        if (persisted) {
          notices.push(
            searchResumeNotice(persisted, {
              noun: "result",
              capReached: collectionCapReached || fileRendered.capReached,
            }),
          );
          details.fullOutputPath = persisted.path;
        }
      }
      if (walk.visitCapReached) {
        details.visitCapReached = true;
        if (!resultLimitReached && !coverageHonesty) {
          notices.push("Directory tree too large, search stopped early. Narrow the path argument");
        }
      }
      if (notices.length > 0) {
        resultOutput += `\n\n[${notices.join(". ")}]`;
      }
      if (coverageHonesty) {
        const coverageNotice = searchCoverageNotice(coverage, coverageOptions);
        if (coverageNotice) {
          resultOutput += `\n\n${coverageNotice}`;
          details.coverage = coverage;
        }
      }
      return {
        content: [{ type: "text", text: resultOutput }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}
