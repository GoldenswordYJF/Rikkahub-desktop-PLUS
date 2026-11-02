// workspace/ops/read-dedup.ts — S4:重复读取短路(按会话的读取指纹)
//
// 目标:同一会话里对同一文件、同一 offset/limit 的重复读取,若内容没变且上一次的
// 全文**仍在即将发送的消息列表里**,第二次只回一行引用,不再回灌整段正文。
//
// 正确性约束(docs/plan-ops-tool-surface.md §4 S4,最高优先级):
// - 证据不足一律回全文:没有探针(聊天通路未挂载工作区工具 / 子智能体)、探针没命中
//   原全文、revision 变了、工作区或权限签名变了 —— 全部走全文并刷新登记。
// - 压缩失效靠证据自然成立:pi 压缩后 session.messages 只剩压缩视图,原全文被移除,
//   探针找不到 [ref=...] 标记,自然回全文;registry 自身不感知压缩。
// - 标记不可自证:全文尾部是 `[ref=rXXXXXXXX]`,`[ref=` 前缀保证短结果(只写 `ref #…`)
//   与系统提示词示例都不会被探针误判为证据。
// - ref 由「键 + revision」派生:文件改过再改回来时,旧全文的 ref 与新 revision 派生值
//   一致 —— 内容逐字相同,复用旧全文是正确的;文件变了但 ref 未变的情况不存在
//   (revision 变 ⇒ ref 变),所以旧全文不会被误当新内容。
// - 保留上限:每会话 32 条、全会话 128 个(超限淘汰最旧;被淘汰的读只影响去重收益,
//   不影响正确性)。

import { createHash } from "node:crypto";
import { state } from "../../persistence/json-store";

/** S4 开关(灰度;默认关)。去重依赖 readContract 的尾部格式,契约关闭时本模块不生效。 */
export function readDedupEnabled(): boolean {
  return state?.settings?.workspaceTools?.readDedup === true;
}

/** 原文证据句柄:工具在 pi session 建立前构造,runner 在 prompt 前挂上探针、收尾时摘除。
 *  探针语义 = 「本轮将发送的消息里是否还有这条 read 全文」;缺省 = 证据不足 → 全文。 */
export interface ReadEvidenceHandle {
  probe?: (marker: string) => boolean;
}

export interface ReadDedupQuery {
  conversationId: string;
  /** 工作区身份 + 根目录 + cwd + 权限档(任一变化都失效)。 */
  workspaceSignature: string;
  /** 解析后的绝对路径(键的一部分;展示给模型的是 displayPath)。 */
  absolutePath: string;
  offset?: number;
  limit?: number;
}

export interface ReadDedupEntry {
  /** 全文尾部的引用编号(`[ref=<ref>]`),短结果指向它。 */
  ref: string;
  revision: string;
  /** 模型传入的原始路径(短结果里原样回显,模型不需要做路径换算)。 */
  displayPath: string;
  /** 1-based 行号范围(与 read 契约的行号同一口径)。 */
  startLine: number;
  endLine: number;
  totalFileLines: number;
  more: boolean;
  nextOffset: number;
  storedAt: number;
}

const ENTRY_LIMIT_PER_CONVERSATION = 32;
const CONVERSATION_LIMIT = 128;

/** conversationId → (key → entry)。Map 的插入顺序即 LRU 顺序(命中/登记都先删后插)。 */
const byConversation = new Map<string, Map<string, ReadDedupEntry>>();

function conversationEntries(conversationId: string, create: boolean): Map<string, ReadDedupEntry> | undefined {
  let entries = byConversation.get(conversationId);
  if (!entries && create) {
    entries = new Map();
    byConversation.set(conversationId, entries);
    if (byConversation.size > CONVERSATION_LIMIT) {
      const oldest = byConversation.keys().next().value;
      if (oldest !== undefined && oldest !== conversationId) byConversation.delete(oldest);
    }
  }
  return entries;
}

export function readDedupKey(query: ReadDedupQuery): string {
  return [query.conversationId, query.workspaceSignature, query.absolutePath, query.offset ?? "", query.limit ?? ""].join("\u0000");
}

/** 引用编号 = key + revision 的短哈希:确定性、无需计数器、旧全文不会冒充新内容。 */
export function readDedupRef(key: string, revision: string): string {
  return `r${createHash("sha256").update(`${key}\u0000${revision}`).digest("hex").slice(0, 8)}`;
}

/** 命中 = 键存在且 revision 一致(调用方仍需探针确认原文还在场)。命中刷新 LRU 位置。 */
export function lookupReadDedup(query: ReadDedupQuery, revision: string): ReadDedupEntry | undefined {
  const entries = conversationEntries(query.conversationId, false);
  if (!entries) return undefined;
  const key = readDedupKey(query);
  const entry = entries.get(key);
  if (!entry || entry.revision !== revision) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/** 登记一次全文读取(同键覆盖;超限淘汰最旧)。 */
export function registerReadDedup(query: ReadDedupQuery, entry: ReadDedupEntry): void {
  const entries = conversationEntries(query.conversationId, true)!;
  const key = readDedupKey(query);
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > ENTRY_LIMIT_PER_CONVERSATION) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** 主动失效一条指纹(文件删除/权限收窄等外部信号接入时用;当前读路径靠 revision 自校验)。 */
export function invalidateReadDedup(query: ReadDedupQuery): void {
  conversationEntries(query.conversationId, false)?.delete(readDedupKey(query));
}

/** 诊断/测试:当前会话的条目数。 */
export function readDedupSize(conversationId: string): number {
  return conversationEntries(conversationId, false)?.size ?? 0;
}

export function resetReadDedupForTests(): void {
  byConversation.clear();
}
