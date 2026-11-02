// agent-loop/run-store.ts — 运行记录读写(S1)
//
// 纪律:
//  - 全部写入 best-effort:记录失败绝不能影响生成主链路(捕获后 warn 一次)。
//  - 只存摘要与计数,不存工具输出正文/模型正文(plan §4.2)。
//  - 保留最近 AGENT_RUN_RETENTION_PER_CONVERSATION 条,超出淘汰(先删事件再删行,
//    不依赖 foreign_keys pragma 是否开启)。

import type { Database } from "bun:sqlite";
import { getConversationsDb } from "../conversations/index";
import {
  parseBoundarySnapshot,
  type ToolBoundaryAccess,
  type ToolBoundarySnapshot,
  type ToolBoundaryTargetScope,
} from "../foundation/tool-boundary";
import { AGENT_RUN_RETENTION_PER_CONVERSATION } from "./schema";
import type {
  AgentRunEventDto,
  AgentRunEventKind,
  AgentRunEventPageDto,
  AgentRunPhase,
  AgentRunSnapshotDto,
  AgentRunStatus,
  AgentRunSummary,
} from "./types";

/** 事件分页默认页大小与上限(契约测试固定;limit 非法时回默认,超过只钳不报错)。 */
export const AGENT_RUN_EVENT_PAGE_DEFAULT = 200;
export const AGENT_RUN_EVENT_PAGE_MAX = 300;

export function normalizeEventPageLimit(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return AGENT_RUN_EVENT_PAGE_DEFAULT;
  const floored = Math.floor(value);
  if (floored < 1) return AGENT_RUN_EVENT_PAGE_DEFAULT;
  return Math.min(floored, AGENT_RUN_EVENT_PAGE_MAX);
}

interface RunRow {
  id: string;
  conversation_id: string;
  node_id: string | null;
  engine: string;
  status: string;
  phase: string;
  stop_reason: string | null;
  rounds: number;
  attempts: number;
  replan_count: number;
  stall_reason: string | null;
  goal: string | null;
  started_at: number;
  ended_at: number | null;
  error: string | null;
}

interface EventRow {
  seq: number;
  at: number;
  kind: string;
  summary: string;
  payload: string | null;
}

const warned = new Set<string>();
function warnOnce(key: string, err: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[agent-loop] 运行记录写入失败(${key},该功能降级为不可见,不影响生成)`, err);
}

function db(): InstanceType<typeof Database> | null {
  try {
    return getConversationsDb();
  } catch {
    return null;
  }
}

function toSummary(row: RunRow): AgentRunSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    nodeId: row.node_id,
    engine: row.engine,
    status: row.status as AgentRunStatus,
    phase: row.phase as AgentRunPhase,
    stopReason: row.stop_reason,
    rounds: row.rounds,
    attempts: row.attempts,
    replanCount: row.replan_count,
    stallReason: row.stall_reason,
    goal: row.goal,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
  };
}

function toEvent(row: EventRow): AgentRunEventDto {
  let payload: AgentRunEventDto["payload"] = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as AgentRunEventDto["payload"];
    } catch {
      payload = null;
    }
  }
  return { seq: row.seq, at: row.at, kind: row.kind as AgentRunEventKind, summary: row.summary, payload };
}

function trimRuns(handle: InstanceType<typeof Database>, conversationId: string): void {
  handle
    .prepare(
      `DELETE FROM pc_generation_run_event WHERE run_id IN (
         SELECT id FROM pc_generation_run
         WHERE conversation_id = ?
           AND id NOT IN (
             SELECT id FROM pc_generation_run WHERE conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
           )
       )`,
    )
    .run(conversationId, conversationId, AGENT_RUN_RETENTION_PER_CONVERSATION);
  handle
    .prepare(
      `DELETE FROM pc_generation_run
       WHERE conversation_id = ?
         AND id NOT IN (
           SELECT id FROM pc_generation_run WHERE conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
         )`,
    )
    .run(conversationId, conversationId, AGENT_RUN_RETENTION_PER_CONVERSATION);
}

export function insertRun(input: {
  id: string;
  conversationId: string;
  nodeId: string | null;
  engine: string;
  startedAt: number;
}): boolean {
  const handle = db();
  if (!handle) return false;
  try {
    handle
      .prepare(
        `INSERT INTO pc_generation_run (id, conversation_id, node_id, engine, status, phase, started_at)
         VALUES (?, ?, ?, ?, 'running', 'planning', ?)`,
      )
      .run(input.id, input.conversationId, input.nodeId, input.engine, input.startedAt);
    trimRuns(handle, input.conversationId);
    return true;
  } catch (err) {
    warnOnce("insertRun", err);
    return false;
  }
}

export interface RunPatch {
  status?: AgentRunStatus;
  phase?: AgentRunPhase;
  stopReason?: string | null;
  rounds?: number;
  attempts?: number;
  replanCount?: number;
  stallReason?: string | null;
  goal?: string | null;
  endedAt?: number | null;
  error?: string | null;
}

const PATCH_COLUMNS: Array<[keyof RunPatch, string]> = [
  ["status", "status"],
  ["phase", "phase"],
  ["stopReason", "stop_reason"],
  ["rounds", "rounds"],
  ["attempts", "attempts"],
  ["replanCount", "replan_count"],
  ["stallReason", "stall_reason"],
  ["goal", "goal"],
  ["endedAt", "ended_at"],
  ["error", "error"],
];

export function updateRun(id: string, patch: RunPatch): void {
  const handle = db();
  if (!handle) return;
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of PATCH_COLUMNS) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  try {
    handle.prepare(`UPDATE pc_generation_run SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  } catch (err) {
    warnOnce("updateRun", err);
  }
}

/** 追加一条运行事件并返回落库后的 DTO(seq 由本函数分配)。 */
export function appendRunEvent(
  runId: string,
  kind: AgentRunEventKind,
  summary: string,
  payload: AgentRunEventDto["payload"] = null,
): AgentRunEventDto | null {
  const handle = db();
  if (!handle) return null;
  const at = Date.now();
  const text = summary.length > 240 ? `${summary.slice(0, 239)}…` : summary;
  try {
    const write = handle.transaction((): AgentRunEventDto => {
      const row = handle
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM pc_generation_run_event WHERE run_id = ?")
        .get(runId) as { seq: number } | null;
      const seq = row?.seq ?? 1;
      handle
        .prepare("INSERT INTO pc_generation_run_event (run_id, seq, at, kind, summary, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, seq, at, kind, text, payload === null ? null : JSON.stringify(payload));
      return { seq, at, kind, summary: text, payload };
    });
    return write();
  } catch (err) {
    warnOnce("appendRunEvent", err);
    return null;
  }
}

function rowById(handle: InstanceType<typeof Database>, id: string): AgentRunSummary | null {
  const row = handle.prepare("SELECT * FROM pc_generation_run WHERE id = ?").get(id) as RunRow | null;
  return row ? toSummary(row) : null;
}

export function getRun(runId: string): AgentRunSummary | null {
  const handle = db();
  if (!handle) return null;
  try {
    return rowById(handle, runId);
  } catch (err) {
    warnOnce("getRun", err);
    return null;
  }
}

export function latestRun(conversationId: string): AgentRunSummary | null {
  const handle = db();
  if (!handle) return null;
  try {
    const row = handle
      .prepare(
        "SELECT * FROM pc_generation_run WHERE conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(conversationId) as RunRow | null;
    return row ? toSummary(row) : null;
  } catch (err) {
    warnOnce("latestRun", err);
    return null;
  }
}

/** O1:保留的 run 列表(不携带事件),与 latestRun/淘汰共用同一确定性排序。 */
export function listRuns(conversationId: string): AgentRunSummary[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(
        `SELECT * FROM pc_generation_run WHERE conversation_id = ?
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, AGENT_RUN_RETENTION_PER_CONVERSATION) as RunRow[];
    return rows.map(toSummary);
  } catch (err) {
    warnOnce("listRuns", err);
    return [];
  }
}

/** O1:按归属读取单条 run;跨会话读取必须视作不存在(路由据此 404)。 */
export function getRunForConversation(conversationId: string, runId: string): AgentRunSummary | null {
  const run = getRun(runId);
  return run && run.conversationId === conversationId ? run : null;
}

/** pause-resume 引擎的审批暂停:最近一条 suspended run(批准后重触发续跑时接续它)。 */
export function latestSuspendedRun(conversationId: string): AgentRunSummary | null {
  const handle = db();
  if (!handle) return null;
  try {
    const row = handle
      .prepare(
        "SELECT * FROM pc_generation_run WHERE conversation_id = ? AND status = 'suspended' ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(conversationId) as RunRow | null;
    return row ? toSummary(row) : null;
  } catch (err) {
    warnOnce("latestSuspendedRun", err);
    return null;
  }
}

/** 事件页(契约核心):beforeSeq 严格 seq < beforeSeq;不带游标即最新一页。
 *  页内仍按 seq ASC 返回;hasMore 表示更早处还有事件。
 *  非法游标(非正整数)返回空页而不是回落成最新页——避免坏游标把尾部重复拼进历史。 */
export function listRunEventPage(
  runId: string,
  options: { beforeSeq?: number | null; limit?: unknown } = {},
): AgentRunEventPageDto {
  const empty: AgentRunEventPageDto = {
    runId,
    events: [],
    hasMore: false,
    nextBeforeSeq: null,
    throughSeq: null,
  };
  const handle = db();
  if (!handle) return empty;
  const beforeSeq = options.beforeSeq ?? null;
  if (beforeSeq !== null && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) return empty;
  const limit = normalizeEventPageLimit(options.limit);
  try {
    const rows = (
      beforeSeq === null
        ? handle
            .prepare(
              `SELECT seq, at, kind, summary, payload FROM pc_generation_run_event
               WHERE run_id = ? ORDER BY seq DESC LIMIT ?`,
            )
            .all(runId, limit + 1)
        : handle
            .prepare(
              `SELECT seq, at, kind, summary, payload FROM pc_generation_run_event
               WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
            )
            .all(runId, beforeSeq, limit + 1)
    ) as EventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).reverse().map(toEvent);
    return {
      runId,
      events,
      hasMore,
      nextBeforeSeq: events.length > 0 ? events[0]!.seq : null,
      throughSeq: events.length > 0 ? events[events.length - 1]!.seq : null,
    };
  } catch (err) {
    warnOnce("listRunEventPage", err);
    return empty;
  }
}

/** 兼容读取:默认上限内的一页事件(升序)。长运行应使用 listRunEventPage 并向前翻页。 */
export function listRunEvents(runId: string, limit = AGENT_RUN_EVENT_PAGE_MAX): AgentRunEventDto[] {
  return listRunEventPage(runId, { limit }).events;
}

function payloadRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** O4:run 内出现过的全部边界定义(按 boundaryId 去重,首见即定义)。
 *  投影与 run tracker 的恢复种子共用——不依赖当前已加载的事件页。 */
export function boundarySnapshotsForRun(runId: string): Record<string, ToolBoundarySnapshot> {
  const handle = db();
  if (!handle) return {};
  try {
    const rows = handle
      .prepare("SELECT payload FROM pc_generation_run_event WHERE run_id = ? AND kind = 'boundary' ORDER BY seq ASC")
      .all(runId) as Array<{ payload: string | null }>;
    const out: Record<string, ToolBoundarySnapshot> = {};
    for (const row of rows) {
      const payload = payloadRecord(row.payload);
      if (!payload || typeof payload.boundaryId !== "string") continue;
      if (out[payload.boundaryId]) continue;
      const snapshot = parseBoundarySnapshot(payload);
      if (snapshot) out[payload.boundaryId] = snapshot;
    }
    return out;
  } catch (err) {
    warnOnce("boundarySnapshotsForRun", err);
    return {};
  }
}

/** O4:审批事件里的使用语境(toolCallId → 审批时点 boundaryId/access/targetScope)。
 *  resume 后补记决定时沿用它,避免把审批时点快照改成执行时点快照。 */
export interface RunApprovalUsage {
  boundaryId: string | null;
  access: ToolBoundaryAccess | null;
  targetScope: ToolBoundaryTargetScope | null;
}

export function approvalUsagesForRun(runId: string): Map<string, RunApprovalUsage> {
  const handle = db();
  if (!handle) return new Map();
  try {
    const rows = handle
      .prepare("SELECT payload FROM pc_generation_run_event WHERE run_id = ? AND kind = 'approval' ORDER BY seq ASC")
      .all(runId) as Array<{ payload: string | null }>;
    const out = new Map<string, RunApprovalUsage>();
    for (const row of rows) {
      const payload = payloadRecord(row.payload);
      if (!payload || typeof payload.toolCallId !== "string") continue;
      const boundaryId = typeof payload.boundaryId === "string" ? payload.boundaryId : null;
      const access =
        payload.access === "read" || payload.access === "write" || payload.access === "execute"
          ? payload.access
          : null;
      const targetScope =
        payload.targetScope === "inside" || payload.targetScope === "outside" || payload.targetScope === "unknown"
          ? payload.targetScope
          : null;
      const previous = out.get(payload.toolCallId);
      out.set(payload.toolCallId, {
        boundaryId: boundaryId ?? previous?.boundaryId ?? null,
        access: access ?? previous?.access ?? null,
        targetScope: targetScope ?? previous?.targetScope ?? null,
      });
    }
    return out;
  } catch (err) {
    warnOnce("approvalUsagesForRun", err);
    return new Map();
  }
}

/** O4:双路径审批去重键集合(`toolCallId + decision`)。审批端点与事件流可能先后各记
 *  一次同一决定;每个 (runId, toolCallId, decision) 只允许一条流水。 */
export function approvalDecisionKeysForRun(runId: string): Set<string> {
  const keys = new Set<string>();
  const handle = db();
  if (!handle) return keys;
  try {
    const rows = handle
      .prepare("SELECT payload FROM pc_generation_run_event WHERE run_id = ? AND kind = 'approval' ORDER BY seq ASC")
      .all(runId) as Array<{ payload: string | null }>;
    for (const row of rows) {
      const payload = payloadRecord(row.payload);
      if (!payload || typeof payload.toolCallId !== "string") continue;
      if (payload.decision === "approved" || payload.decision === "denied") {
        keys.add(`${payload.toolCallId}\u0000${payload.decision}`);
      }
    }
    return keys;
  } catch (err) {
    warnOnce("approvalDecisionKeysForRun", err);
    return keys;
  }
}


/** O3:该 run 最后一次某种工具的 tool_call 事件(计划投影找 update_plan 来源用)。
 *  直接查全部事件,不经过分页——来源可能在尚未加载的旧页。 */
export function lastToolCallEventForRun(runId: string, toolName: string): AgentRunEventDto | null {
  const handle = db();
  if (!handle) return null;
  try {
    const rows = handle
      .prepare(
        `SELECT seq, at, kind, summary, payload FROM pc_generation_run_event
         WHERE run_id = ? AND kind = 'tool_call' ORDER BY seq DESC`,
      )
      .all(runId) as EventRow[];
    for (const row of rows) {
      const event = toEvent(row);
      const payload = event.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.toolName === toolName) {
        return event;
      }
    }
    return null;
  } catch (err) {
    warnOnce("lastToolCallEventForRun", err);
    return null;
  }
}

/** 会话详情首帧/GET 用:最近一条 run + 最新一页事件与窗口信息(没有则 run=null)。
 *  O1 前这里返回最早 300 条,长运行刷新后末尾事件会消失;现在永远以尾部窗口为准。 */
export function getRunSnapshot(conversationId: string): AgentRunSnapshotDto {
  const run = latestRun(conversationId);
  if (!run) {
    return { run: null, events: [], hasMore: false, nextBeforeSeq: null, throughSeq: null };
  }
  const page = listRunEventPage(run.id);
  return {
    run,
    events: page.events,
    hasMore: page.hasMore,
    nextBeforeSeq: page.nextBeforeSeq,
    throughSeq: page.throughSeq,
  };
}
