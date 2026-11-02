// workspace/ops/read-files.ts — S7:批量读取工具(PC 专属)
//
// 动机(docs/plan-ops-tool-surface.md §4 S7):多文件场景下逐个 read 会拉长轮次、
// 挤占上下文;read_files 一次读 1–32 个文件,每项独立 offset/limit、独立错误,
// 单项失败不牵连其他项。
//
// 纪律:
// - 每个文件的正文由 pi read 内核原样产出(截断/图片/错误文案与 read 逐字一致),
//   再走 S2 装饰层;契约开关关闭时保持内核原文,逐项仍自带内核的续读提示。
// - 两层完成状态:每个文件正文自带 complete / nextOffset(或错误),响应尾部在
//   响应预算耗尽时明确列出整体 pending(未读文件清单)。
// - 响应按转义后文本 + 图片数据的总字节设上限;超预算的文件不纳入本次响应,
//   由模型再次调用补齐。
// - 不接入 S4 重复读取去重:批量读取的目标是一次拿全;接入短路会牺牲证据完整性。

import { createWideReadOperations } from "../boundary";
import { formatSize } from "../tools/truncate";
import { createReadTool } from "../tools/read";
import type {
  ToolImageContent,
  ToolTextContent,
  WorkspaceToolContent,
  WorkspaceToolDefinition,
  WorkspaceToolOutput,
} from "../tools/types";
import { decorateReadOutput } from "./read-contract";

export interface ReadFilesItemInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFilesToolInput {
  files: ReadFilesItemInput[];
}

export const READ_FILES_MAX_FILES = 32;
/** 响应预算:转义后文本 + 图片 base64 字节的总上限。 */
export const READ_FILES_RESPONSE_BUDGET_BYTES = 200 * 1024;

export type ReadFileStatus = "complete" | "more" | "error" | "skipped";

export interface ReadFileDetail {
  path: string;
  status: ReadFileStatus;
  revision?: string;
  nextOffset?: number;
  error?: string;
}

export interface ReadFilesToolDetails {
  files: ReadFileDetail[];
  /** 因响应预算未读的条目数(整体 pending)。 */
  pending?: number;
}

export interface ReadFilesToolOptions {
  /** S2 契约开关:开启时逐项套行号/revision/续读位;关闭时保持内核原文。 */
  readContract?: boolean;
}

const READ_FILES_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      description: `Files to read (1-${READ_FILES_MAX_FILES} entries, each with its own optional offset/limit).`,
      minItems: 1,
      maxItems: READ_FILES_MAX_FILES,
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (absolute, or relative to the current directory)" },
          offset: { type: "number", description: "1-indexed line to start from (optional)" },
          limit: { type: "number", description: "Maximum number of lines to read (optional)" },
        },
        required: ["path"],
      },
    },
  },
  required: ["files"],
} as const;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/** 从单项正文解析完成状态:优先认 S2 契约尾行,其次认 read 内核的续读提示。 */
export function parseReadCompletion(text: string): {
  status: "complete" | "more";
  revision?: string;
  nextOffset?: number;
} {
  const trimmed = text.trimEnd();
  const contract = /\[revision=([0-9a-f]+); \d+ lines?; (end of file|more lines; nextOffset=(\d+))\]$/.exec(trimmed);
  if (contract) {
    if (contract[2] === "end of file") return { status: "complete", revision: contract[1] };
    return { status: "more", revision: contract[1], nextOffset: Number(contract[3]) };
  }
  const kernel = /\[(?:Showing lines \d+-\d+ of \d+[^\]]*|\d+ more lines in file[^\]]*)\]$/.exec(trimmed);
  const next = kernel ? /Use offset=(\d+) to continue\./.exec(kernel[0]) : null;
  if (next) return { status: "more", nextOffset: Number(next[1]) };
  return { status: "complete" };
}

function headingFor(pathArg: string, offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) return `### ${pathArg}`;
  const parts = [offset === undefined ? "offset=1" : `offset=${offset}`];
  if (limit !== undefined) parts.push(`limit=${limit}`);
  return `### ${pathArg} (${parts.join(", ")})`;
}

export function createReadFilesTool(
  cwd: string,
  options?: ReadFilesToolOptions,
): WorkspaceToolDefinition<ReadFilesToolInput, ReadFilesToolDetails | undefined> {
  const readTool = createReadTool(cwd, { operations: createWideReadOperations() });
  const readContract = options?.readContract === true;
  return {
    name: "read_files",
    description: `Read up to ${READ_FILES_MAX_FILES} files in one call. Each entry is read independently with its own optional offset/limit; a failure on one entry is reported in place and does not affect the others. Per-file text follows the read tool's format. The response is capped at ${formatSize(READ_FILES_RESPONSE_BUDGET_BYTES)}; entries that do not fit are listed as pending — call read_files again to read them.`,
    parameters: READ_FILES_SCHEMA as unknown as Record<string, unknown>,
    async execute({ files }, signal?) {
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error(`read_files requires 1-${READ_FILES_MAX_FILES} files (received none).`);
      }
      if (files.length > READ_FILES_MAX_FILES) {
        throw new Error(
          `read_files accepts at most ${READ_FILES_MAX_FILES} files per call (received ${files.length}).`,
        );
      }

      const content: WorkspaceToolContent[] = [];
      const fileDetails: ReadFileDetail[] = [];
      const pendingPaths: string[] = [];
      let usedBytes = 0;
      let readCount = 0;

      for (const [index, raw] of files.entries()) {
        if (signal?.aborted) throw new Error("Operation aborted");
        const item = raw as ReadFilesItemInput;
        const pathArg = typeof item?.path === "string" ? item.path.trim() : "";
        if (!pathArg) {
          const text = `### (entry ${index + 1})\nError: missing path`;
          usedBytes += byteLength(text) + 1;
          content.push({ type: "text", text });
          fileDetails.push({ path: "", status: "error", error: "missing path" });
          continue;
        }
        const offset = typeof item.offset === "number" ? item.offset : undefined;
        const limit = typeof item.limit === "number" ? item.limit : undefined;

        let output: WorkspaceToolOutput<unknown>;
        try {
          output = await readTool.execute(
            { path: pathArg, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) },
            signal,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const text = `${headingFor(pathArg, offset, limit)}\nError: ${message}`;
          usedBytes += byteLength(text) + 1;
          content.push({ type: "text", text });
          fileDetails.push({ path: pathArg, status: "error", error: message });
          continue;
        }

        if (readContract) {
          output = await decorateReadOutput({ pathArg, offset, limit, cwd }, output, {
            contractEnabled: true,
            dedupEnabled: false,
          });
        }

        const textBlocks = output.content.filter((entry): entry is ToolTextContent => entry.type === "text");
        const imageBlocks = output.content.filter((entry): entry is ToolImageContent => entry.type === "image");
        const bodyText = textBlocks.map((block) => block.text).join("\n");
        const itemText = `${headingFor(pathArg, offset, limit)}\n${bodyText}`;
        const itemBytes =
          byteLength(itemText) + 1 + imageBlocks.reduce((sum, block) => sum + block.data.length, 0);

        if (usedBytes + itemBytes > READ_FILES_RESPONSE_BUDGET_BYTES) {
          // 预算耗尽:本项不读,记入整体 pending;后续文件仍尝试(小文件可能还放得下)。
          pendingPaths.push(pathArg);
          fileDetails.push({ path: pathArg, status: "skipped" });
          continue;
        }

        usedBytes += itemBytes;
        readCount += 1;
        content.push({ type: "text", text: itemText });
        content.push(...imageBlocks);
        const completion = parseReadCompletion(bodyText);
        fileDetails.push({
          path: pathArg,
          status: completion.status,
          ...(completion.revision ? { revision: completion.revision } : {}),
          ...(completion.nextOffset ? { nextOffset: completion.nextOffset } : {}),
        });
      }

      if (pendingPaths.length > 0) {
        content.push({
          type: "text",
          text:
            `[Read ${readCount} of ${files.length} files; response budget of ${formatSize(READ_FILES_RESPONSE_BUDGET_BYTES)} reached. `
            + `Not read: ${pendingPaths.join(", ")} — call read_files again for these files.]`,
        });
      }

      return {
        content,
        details: {
          files: fileDetails,
          ...(pendingPaths.length > 0 ? { pending: pendingPaths.length } : {}),
        },
      };
    },
  };
}
