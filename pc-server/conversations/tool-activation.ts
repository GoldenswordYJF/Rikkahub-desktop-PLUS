// conversations/tool-activation.ts — S9 工具发现的会话级激活集(活库持久化)
//
// 语义:激活集分两段——active(下一轮组装时携带 schema)/ pending(search_tools 命中
// 但尚未到轮边界)。写了 pending 后由生成循环在轮边界调 promote 提升;"命中只登记、
// 下一轮生效"的时序保证本轮请求体在工具执行前就已定稿,不被中途改写。
//
// 纪律:
//  - 读写永不抛错(库未开/列缺失/JSON 损坏 → 空集),发现行是增强,不能拖垮生成;
//  - 只认 MCP 工具全名(调用方已按当前工具池过滤),本模块不做工具存在性判定;
//  - 名字去重 + 上限截断,避免模型反复 search 把列撑大;
//  - 会话删除随行消失;跨端导出白名单不含 tool_activation 列(PC 自有库专列);
//  - S11:名字是否"可见"由调用方的实时池决定(服务器禁用/删除、工具开关、助手覆盖
//    收窄都会让名字从池里消失),prune 只负责按给定池清理,不猜配置。

import type { Database } from "bun:sqlite";
import { uniqueStrings } from "../foundation/utils";
import { isRecord } from "../foundation/utils";
import { getConversationsDb } from "./index";

export interface ToolActivationState {
  /** 已激活:下一轮工具数组按此集合放行 MCP schema。 */
  active: string[];
  /** 待激活:search_tools 本轮命中的工具,轮边界提升为 active。 */
  pending: string[];
}

/** 上限:active 覆盖一次会话里真实会被调用的工具远少于该数;pending 是单轮召回缓存。 */
const MAX_ACTIVE = 64;
/** 单轮 search_tools 登记上限(测试可见:截断语义是外部契约的一部分)。 */
export const TOOL_ACTIVATION_MAX_PENDING = 16;

export function emptyToolActivation(): ToolActivationState {
  return { active: [], pending: [] };
}

function nameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean));
}

/** 宽容归一:两段互斥(active 优先),各自去重截断。任何非对象输入 → 空集。 */
export function normalizeToolActivation(raw: unknown): ToolActivationState {
  if (!isRecord(raw)) return emptyToolActivation();
  const active = nameList(raw.active).slice(0, MAX_ACTIVE);
  const activeSet = new Set(active);
  const pending = nameList(raw.pending).filter((name) => !activeSet.has(name)).slice(0, TOOL_ACTIVATION_MAX_PENDING);
  return { active, pending };
}

export function readToolActivationFrom(db: InstanceType<typeof Database>, conversationId: string): ToolActivationState {
  if (!conversationId) return emptyToolActivation();
  try {
    const row = db.prepare("SELECT tool_activation FROM pc_conversation WHERE id = ?").get(conversationId) as
      | { tool_activation?: string | null }
      | null;
    if (!row?.tool_activation) return emptyToolActivation();
    return normalizeToolActivation(JSON.parse(row.tool_activation));
  } catch {
    // 列缺失(老库迁移失败)/ JSON 损坏:发现行按未激活处理,不影响会话读写。
    return emptyToolActivation();
  }
}

export function writeToolActivationInto(
  db: InstanceType<typeof Database>,
  conversationId: string,
  state: ToolActivationState,
): void {
  if (!conversationId) return;
  try {
    const normalized = normalizeToolActivation(state);
    db.prepare("UPDATE pc_conversation SET tool_activation = ? WHERE id = ?").run(
      JSON.stringify(normalized),
      conversationId,
    );
  } catch {
    // 写失败(列缺失/库只读):本次生成内发现行降级为"下轮仍不可见",状态不落盘。
  }
}

/** 登记本轮命中的工具为 pending;返回真正新增的名字(已激活/已在 pending 的不算)。
 *  只登记、不改本轮请求体——这是 S9 的时序契约。 */
export function registerPendingToolActivationIn(
  db: InstanceType<typeof Database>,
  conversationId: string,
  names: string[],
): string[] {
  const current = readToolActivationFrom(db, conversationId);
  const activeSet = new Set(current.active);
  const pending = [...current.pending];
  const pendingSet = new Set(pending);
  const added: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name || activeSet.has(name) || pendingSet.has(name)) continue;
    if (pending.length >= TOOL_ACTIVATION_MAX_PENDING) break;
    pending.push(name);
    pendingSet.add(name);
    added.push(name);
  }
  if (added.length) writeToolActivationInto(db, conversationId, { active: current.active, pending });
  return added;
}

/** 轮边界:把 pending 全量提升为 active;返回本次提升的名字(空数组 = 无变化)。
 *  提升后清空 pending——下一次 search 重新登记,避免集合无限增长。 */
export function promotePendingToolActivationIn(
  db: InstanceType<typeof Database>,
  conversationId: string,
): string[] {
  const current = readToolActivationFrom(db, conversationId);
  if (current.pending.length === 0) return [];
  const active = uniqueStrings([...current.active, ...current.pending]).slice(0, MAX_ACTIVE);
  const activeSet = new Set(active);
  const promoted = current.pending.filter((name) => activeSet.has(name));
  writeToolActivationInto(db, conversationId, { active, pending: [] });
  return promoted;
}

/** S11 失效清理:按"当前仍可见的工具名"过滤 active 与 pending(服务器禁用/删除、
 *  工具开关、助手覆盖收窄都会让名字从池里消失)。返回被移除的名字(active 在前、
 *  pending 在后,去重保序);空数组 = 无变化、不写库。永不抛错。
 *  清理后这些名字不再从历史激活集复活:重新启用服务器/工具后需重新 search 发现。 */
export function pruneToolActivationIn(
  db: InstanceType<typeof Database>,
  conversationId: string,
  liveNames: Iterable<string>,
): string[] {
  if (!conversationId) return [];
  const live = liveNames instanceof Set ? liveNames : new Set(liveNames);
  const current = readToolActivationFrom(db, conversationId);
  const active = current.active.filter((name) => live.has(name));
  const activeSet = new Set(active);
  const pending = current.pending.filter((name) => live.has(name) && !activeSet.has(name));
  const removed = uniqueStrings([
    ...current.active.filter((name) => !live.has(name)),
    ...current.pending.filter((name) => !live.has(name)),
  ]);
  if (removed.length === 0) return [];
  writeToolActivationInto(db, conversationId, { active, pending });
  return removed;
}

function runtimeDb(): InstanceType<typeof Database> | null {
  try {
    return getConversationsDb();
  } catch {
    return null;
  }
}

/** 生产读口:库未开 → 空集(与"未激活"同义,生成不阻塞)。 */
export function readToolActivation(conversationId: string): ToolActivationState {
  const db = runtimeDb();
  return db ? readToolActivationFrom(db, conversationId) : emptyToolActivation();
}

export function registerPendingToolActivation(conversationId: string, names: string[]): string[] {
  const db = runtimeDb();
  return db ? registerPendingToolActivationIn(db, conversationId, names) : [];
}

export function promotePendingToolActivation(conversationId: string): string[] {
  const db = runtimeDb();
  return db ? promotePendingToolActivationIn(db, conversationId) : [];
}

/** 生产清理口:库未开 → 无操作(与"没有激活集"同义)。 */
export function pruneToolActivation(conversationId: string, liveNames: Iterable<string>): string[] {
  const db = runtimeDb();
  return db ? pruneToolActivationIn(db, conversationId, liveNames) : [];
}
