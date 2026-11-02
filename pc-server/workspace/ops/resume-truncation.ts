// workspace/ops/resume-truncation.ts — S6:截断结果可续读(PC 专属)
//
// 目标(docs/plan-ops-tool-surface.md §4 S6):一次超长输出之后,模型不需要重跑命令
// 就能分页读完,并能只搜索其中一段。
// - bash 内核早已把超长输出落盘到工作区 tmp/;这里把裸路径提示升级为
//   「总量 + 落盘路径 + read offset/limit 续读 + 可在文件内 grep」的完整指引。
// - grep/find/ls 命中显示上限时,把本轮收集到的完整结果写到同一个 tmp/ 目录,
//   正文仍只展示上限内的内容,尾部给出落盘路径与续读指引。
// - 落盘文件沿用工作区 tmp/ 的既有生命周期(删工作区即删痕迹),不新增清理策略。
//
// 开关默认关(resumableOutput=false):关闭时所有工具输出与引入前逐字一致。
// 本模块只负责写文件与组织文案,不改内核原有截断/上限判定,不改 details 旧字段名。

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { state } from "../../persistence/json-store";
import { formatSize } from "../tools/truncate";

/** S6 开关(灰度;默认关)。 */
export function resumableOutputEnabled(): boolean {
  return state?.settings?.workspaceTools?.resumableOutput === true;
}

/** grep/find/ls 单次收集安全帽:显示上限之外最多再收这么多条,给落盘文件用。
 *  到达此帽时总量未知,文案必须写成 "N+" 而非精确总数。 */
export const RESULT_COLLECT_CAP = 5_000;

/** 落盘文件字节上限(渲染后的文本);超过则截断文件并在文案里标注 "N+"。 */
export const RESULT_FILE_MAX_BYTES = 4 * 1024 * 1024;

export const RESUME_BASH_DESCRIPTION_APPEND =
  " When truncated, the saved file holds the complete output: page through it with read (offset/limit) or grep within it instead of re-running the command.";

export const RESUME_SEARCH_DESCRIPTION_APPEND =
  " When a limit is hit, all collected results are saved to a file in the workspace tmp directory: read it with offset/limit or grep within it instead of re-running the search.";

export interface PersistedToolResult {
  path: string;
  /** 文件里实际包含的行数 */
  lineCount: number;
  bytes: number;
}

/** 把结果行写到工作区 tmp/(与 bash 落盘同一目录与生命周期)。
 *  失败返回 null:落盘只是锦上添花,绝不让工具主结果因写文件失败而报错。 */
export async function persistToolResult(options: {
  tempFileDir: string;
  /** 文件名前缀,如 pi-grep / pi-find / pi-ls(bash 用 pi-bash)。 */
  prefix: string;
  lines: string[];
}): Promise<PersistedToolResult | null> {
  try {
    mkdirSync(options.tempFileDir, { recursive: true });
    const path = join(options.tempFileDir, `${options.prefix}-${randomBytes(8).toString("hex")}.log`);
    const text = options.lines.length > 0 ? `${options.lines.join("\n")}\n` : "";
    await writeFile(path, text, "utf-8");
    return { path, lineCount: options.lines.length, bytes: Buffer.byteLength(text, "utf-8") };
  } catch {
    return null;
  }
}

/** 渲染行按字节预算裁剪(给落盘文件用;保留完整行)。
 *  capReached=true 表示后续内容没有写进文件,文案需标注 "N+"。 */
export function capRenderedLines(
  lines: string[],
  maxBytes: number = RESULT_FILE_MAX_BYTES,
): { lines: string[]; capReached: boolean } {
  let bytes = 0;
  for (let index = 0; index < lines.length; index++) {
    bytes += Buffer.byteLength(lines[index], "utf-8") + 1; // +1 = 换行
    if (bytes > maxBytes) return { lines: lines.slice(0, index), capReached: true };
  }
  return { lines, capReached: false };
}

/** grep/find/ls 达到上限后的续读说明(拼进既有 notices 数组)。
 *  capReached=true 时写成 "N+",避免给出伪精确总数。 */
export function searchResumeNotice(
  persisted: PersistedToolResult,
  options: { noun: "match" | "result" | "entry"; capReached: boolean },
): string {
  const plurals = { match: "matches", result: "results", entry: "entries" } as const;
  const singular = persisted.lineCount === 1 && !options.capReached;
  const label = singular ? options.noun : plurals[options.noun];
  const count = `${persisted.lineCount}${options.capReached ? "+" : ""} ${label}`;
  return (
    `${count} collected in total and saved to ${persisted.path} (${formatSize(persisted.bytes)}): `
    + "page through it with the read tool (offset/limit) or grep within it instead of re-running the search"
  );
}
