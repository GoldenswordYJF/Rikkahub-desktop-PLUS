// workspace/ops/read-contract.ts — S2:read 输出契约(行号 + revision + 续读位)
//
// 落点纪律(docs/dev-workflow.md):不改 workspace/tools/read.ts 的 pi 移植内核,在
// runtime 执行分发处对成功的本地文本读取做后装饰。关闭开关(Settings.workspaceTools
// .readContract)时输出与历史逐字一致——旧会话、旧备份、安卓导入全部无感。
//
// 输出形状:
//   1|first line
//   2|second line
//   [revision=<sha256-32>; <total> lines; end of file]
//   [revision=<sha256-32>; <total> lines; more lines; nextOffset=<n>]
//
// 正确性约束:
// - 任何异常/不匹配形态(图片、二进制、远程读取、首行超限的 bash 提示)一律原样返回,
//   装饰层绝不破坏一次成功的读取。
// - details.truncation 保持内核原值:前端渲染契约不变,续读判断仍以内核口径为准。
// - revision 与文件面板 etag 同算法(ops/revision.ts),S3 的 expectedRevision 直接对照。
// - 正文可逆转义:行首反斜杠双写;形似行号(`N|`)或契约标记(`[revision=`)的行前置
//   一个反斜杠。模型按说明去掉一层反斜杠即得原文,无法伪造行号/尾部状态行。

import { readFile as fsReadFile } from "node:fs/promises";
import { state } from "../../persistence/json-store";
import { resolveReadPathAsync } from "../tools/path-utils";
import type { TruncationResult } from "../tools/truncate";
import type { WorkspaceToolOutput } from "../tools/types";
import {
  lookupReadDedup,
  readDedupEnabled,
  readDedupKey,
  readDedupRef,
  registerReadDedup,
  type ReadDedupEntry,
  type ReadDedupQuery,
} from "./read-dedup";
import { sha256Short } from "./revision";

/** pi 系统提示词 Available tools 里 read 的一行摘要(开关开启时替换旧摘要)。 */
export const READ_CONTRACT_PROMPT_SNIPPET =
  "Read file contents (each line is prefixed `N|text`; results end with [revision=...] and a nextOffset while more lines remain)";

/** 追加到 read 工具 description 的契约说明(开关开启时,聊天与 pi 两条通路同源)。 */
export const READ_CONTRACT_DESCRIPTION_APPEND =
  "\nOutput format: every line is prefixed with its 1-indexed line number as `N|text`. "
  + "The final line is `[revision=<id>; <N> lines; end of file]` or "
  + "`[revision=<id>; <N> lines; more lines; nextOffset=<n>]`; pass offset=<n> to read on. "
  + "A content line that itself begins with a digit followed by `|`, with `[revision=`, or with a backslash is escaped with one leading backslash — strip that one backslash to recover the original text.";

/** S4:去重开启时追加的说明(与契约追加同源拼接;关闭时逐字不出现)。 */
export const READ_DEDUP_DESCRIPTION_APPEND =
  "\nAn identical re-read of the same file at the same offset/limit may return a one-line `[unchanged: ...]` result "
  + "instead of the full text when the revision is unchanged and the earlier full read is still present in the conversation. "
  + "The short result keeps the path, line range, revision and nextOffset; its `ref #<id>` points at the earlier full read. "
  + "Full reads end with a `[ref=<id>]` line for this purpose. Re-read only when the revision changed or you need the raw text again.";

export function readContractEnabled(): boolean {
  return state?.settings?.workspaceTools?.readContract === true;
}

const USER_LIMIT_NOTICE_RE = /\n\n\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+)(?:[^\]]*)\]$/;

/** 正文可逆转义(也只在这里解码,见头注)。 */
function escapeReadLine(line: string): string {
  if (line.startsWith("\\")) return `\\${line}`;
  if (/^\d+\|/.test(line)) return `\\${line}`;
  if (line.startsWith("[revision=")) return `\\${line}`;
  return line;
}

/** S4:去重上下文(会话身份 + 工作区签名 + 原文证据探针)。 */
export interface ReadDedupContext {
  conversationId: string;
  workspaceSignature: string;
  /** 「本轮将发送的消息里仍含该标记」→ true;缺省 = 证据不足(一律回全文)。 */
  probe?: (marker: string) => boolean;
}

export interface ReadDecorationInput {
  /** 模型传入的原始 path(与内核同一解析函数,保证 revision 指向真正读到的文件)。 */
  pathArg: string;
  offset?: number;
  limit?: number;
  cwd: string;
  /** 远程工作区(ssh)不装饰:本地 fs 读不到远端路径,格式对齐留待 ssh 层单独做。 */
  remote?: boolean;
  /** S4:提供且开关开启时才做重复读取短路;缺省 = 只做 S2 装饰。 */
  dedup?: ReadDedupContext;
}

export interface ReadDecorationOptions {
  contractEnabled?: boolean;
  dedupEnabled?: boolean;
}

/** 装饰一次成功的 read 结果。仅当开关开启、形态匹配且文件可再次读取时改写文本块。
 *  第三个参数兼容旧布尔签名(测试用);生产缺省读全局设置。 */
export async function decorateReadOutput(
  input: ReadDecorationInput,
  output: WorkspaceToolOutput<unknown>,
  options: boolean | ReadDecorationOptions = {},
): Promise<WorkspaceToolOutput<unknown>> {
  const opts: ReadDecorationOptions = typeof options === "boolean" ? { contractEnabled: options } : options;
  const contractEnabled = opts.contractEnabled ?? readContractEnabled();
  if (!contractEnabled || input.remote) return output;
  if (output.content.length !== 1) return output;
  const first = output.content[0];
  if (!first || first.type !== "text") return output;
  const truncation = (output.details as { truncation?: TruncationResult } | undefined)?.truncation;
  // 首行超过字节上限时内核给的是 bash 提示,不套行号。
  if (truncation?.firstLineExceedsLimit) return output;
  const pathArg = input.pathArg.trim();
  if (!pathArg) return output;

  let absolutePath: string;
  let buffer: Buffer;
  try {
    absolutePath = await resolveReadPathAsync(pathArg, input.cwd);
    buffer = await fsReadFile(absolutePath);
  } catch {
    // 文件在两次读取之间被删除/改权限:保留内核已经成功返回的内容。
    return output;
  }
  if (buffer.includes(0)) return output; // 二进制:内核按文本返回的内容保持原样
  const text = buffer.toString("utf-8");
  const allLines = text.split("\n");
  const totalFileLines = allLines.length;
  const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
  if (startLine >= allLines.length) return output;
  const startDisplay = startLine + 1;

  // 内核截断时 truncation.content 是不含提示语的正文本体;仅有"用户 limit 提前结束"
  // 提示时(未触发截断)从输出尾部剥掉该提示,换成本契约的 nextOffset 行。
  const body = truncation ? truncation.content : first.text.replace(USER_LIMIT_NOTICE_RE, "");
  if (body.startsWith("Read image file [")) return output;

  const bodyLines = body.split("\n");
  const nextOffset = startDisplay + bodyLines.length;
  const more = nextOffset <= totalFileLines;
  const revision = sha256Short(buffer);

  // S4:同一会话、同一工作区签名、同一路径与参数 → 命中旧全文且证据在场时短路。
  const dedupEnabled = (opts.dedupEnabled ?? readDedupEnabled()) && !!input.dedup;
  const query: ReadDedupQuery | undefined = dedupEnabled
    ? {
        conversationId: input.dedup!.conversationId,
        workspaceSignature: input.dedup!.workspaceSignature,
        absolutePath,
        offset: input.offset,
        limit: input.limit,
      }
    : undefined;
  const ref = query ? readDedupRef(readDedupKey(query), revision) : undefined;
  let shortText: string | undefined;
  if (query && ref && input.dedup!.probe) {
    const entry = lookupReadDedup(query, revision);
    if (entry && input.dedup!.probe(`[ref=${ref}]`)) {
      const linesText = entry.startLine === entry.endLine ? `line ${entry.startLine}` : `lines ${entry.startLine}-${entry.endLine}`;
      shortText =
        `[unchanged: ${entry.displayPath} ${linesText}; revision=${revision}; ${totalFileLines} line${totalFileLines === 1 ? "" : "s"}; `
        + `${more ? `more lines; nextOffset=${nextOffset}` : "end of file"}; ref #${ref} — identical re-read, `
        + "the full content is already in the conversation; reuse it.]";
    }
  }

  const numbered = bodyLines
    .map((line, index) => `${startDisplay + index}|${escapeReadLine(line)}`)
    .join("\n");
  const footer = `[revision=${revision}; ${totalFileLines} line${totalFileLines === 1 ? "" : "s"}; ${
    more ? `more lines; nextOffset=${nextOffset}` : "end of file"
  }]`;
  const fullText = query && ref ? `${numbered}\n${footer}\n[ref=${ref}]` : `${numbered}\n${footer}`;

  if (query && ref) {
    // 登记本次全文:此后的同参数重读若探针仍能找到 [ref=…],即可短路。
    const entry: ReadDedupEntry = {
      ref,
      revision,
      displayPath: pathArg,
      startLine: startDisplay,
      endLine: startDisplay + bodyLines.length - 1,
      totalFileLines,
      more,
      nextOffset,
      storedAt: Date.now(),
    };
    registerReadDedup(query, entry);
  }

  // 小文件的短路文案可能比正文还长:只在确实更省时换成一行的引用,否则照常回全文。
  const outputText = shortText && shortText.length < fullText.length ? shortText : fullText;
  return { ...output, content: [{ type: "text" as const, text: outputText }] };
}
