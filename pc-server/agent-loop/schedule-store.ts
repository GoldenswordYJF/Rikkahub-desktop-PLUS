// agent-loop/schedule-store.ts — 生命周期 L3:耐久任务调度的表、CRUD 与时间算法
//
// 纪律:
//  - 所有 next_run_at 计算集中在 nextScheduleTime / advance 纯函数,路由与 tick 共用,
//    禁止两套时间算法。
//  - 本模块只碰 DB 与时间,不投递消息、不碰生成入口——投递在 scheduler.ts(避免
//    orchestrator ↔ scheduler 循环依赖:orchestrator 只向下依赖这里回写 last_run_*)。
//  - 删除会话时由删除流程显式删本会话的调度,不假设 foreign_keys pragma 恒开启。

import type { Database } from "bun:sqlite";

import { getConversationsDb } from "../conversations";
import { id as newId } from "../foundation/utils";

export const SCHEDULE_MAX_PER_CONVERSATION = 20;
export const SCHEDULE_MIN_INTERVAL_SECONDS = 60;
export const SCHEDULE_MAX_INTERVAL_SECONDS = 2_592_000; // 30 天
export const SCHEDULE_GOAL_MAX_LEN = 2000;
/** 忙会话的 catch_up_once 退避间隔:空闲后只补一次,不逐周期堆积。 */
export const SCHEDULE_BUSY_BACKOFF_MS = 60_000;

export type ScheduleKind = "once" | "fixed_interval";
export type ScheduleMisfirePolicy = "skip" | "catch_up_once";

/** 线上 DTO(前端直接渲染;时间均为 epoch ms)。 */
export interface TaskScheduleDto {
  id: string;
  conversationId: string;
  goal: string;
  kind: ScheduleKind;
  runAt: number | null;
  intervalSeconds: number | null;
  nextRunAt: number;
  enabled: boolean;
  misfirePolicy: ScheduleMisfirePolicy;
  lastRunAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ScheduleRow {
  id: string;
  conversation_id: string;
  goal: string;
  kind: string;
  run_at: number | null;
  interval_seconds: number | null;
  next_run_at: number;
  enabled: number;
  misfire_policy: string;
  last_run_at: number | null;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
}

function toDto(row: ScheduleRow): TaskScheduleDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    goal: row.goal,
    kind: row.kind === "once" ? "once" : "fixed_interval",
    runAt: row.run_at,
    intervalSeconds: row.interval_seconds,
    nextRunAt: row.next_run_at,
    enabled: row.enabled !== 0,
    misfirePolicy: row.misfire_policy === "skip" ? "skip" : "catch_up_once",
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function handle(): InstanceType<typeof Database> | null {
  try {
    return getConversationsDb();
  } catch {
    return null;
  }
}

/** 下一个未来时点(纯函数,路由创建/PATCH 与 tick 共用)。
 *  once 返回 runAt(调用方保证在未来);fixed_interval 返回 now + interval。 */
export function nextScheduleTime(
  input: { kind: ScheduleKind; runAt?: number | null; intervalSeconds?: number | null },
  now: number,
): number {
  if (input.kind === "once") return input.runAt ?? now;
  const interval = Math.round(
    Math.min(
      SCHEDULE_MAX_INTERVAL_SECONDS,
      Math.max(SCHEDULE_MIN_INTERVAL_SECONDS, input.intervalSeconds ?? 3600),
    ),
  );
  return now + interval * 1000;
}

export function listSchedules(conversationId: string): TaskScheduleDto[] {
  const db = handle();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT * FROM pc_task_schedule WHERE conversation_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(conversationId) as ScheduleRow[];
    return rows.map(toDto);
  } catch {
    return [];
  }
}

export function getSchedule(conversationId: string, scheduleId: string): TaskScheduleDto | null {
  const db = handle();
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT * FROM pc_task_schedule WHERE id = ? AND conversation_id = ?")
      .get(scheduleId, conversationId) as ScheduleRow | null;
    return row ? toDto(row) : null;
  } catch {
    return null;
  }
}

export type ScheduleValidation =
  | { ok: true; value: { goal: string; kind: ScheduleKind; runAt: number | null; intervalSeconds: number | null; misfirePolicy: ScheduleMisfirePolicy } }
  | { ok: false; error: string };

/** 创建/修改共用的输入校验;越界整体拒绝,不夹取(与 agent-loop 设置同风格)。 */
export function validateScheduleInput(body: Record<string, unknown>, now: number): ScheduleValidation {
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) return { ok: false, error: "goal is required" };
  if (goal.length > SCHEDULE_GOAL_MAX_LEN) {
    return { ok: false, error: `goal must be at most ${SCHEDULE_GOAL_MAX_LEN} characters` };
  }
  const kind = body.kind;
  if (kind !== "once" && kind !== "fixed_interval") {
    return { ok: false, error: "kind must be 'once' or 'fixed_interval'" };
  }
  const policy = body.misfirePolicy ?? body.misfire_policy ?? "catch_up_once";
  if (policy !== "skip" && policy !== "catch_up_once") {
    return { ok: false, error: "misfirePolicy must be 'skip' or 'catch_up_once'" };
  }
  if (kind === "once") {
    const runAt = body.runAt ?? body.run_at;
    if (typeof runAt !== "number" || !Number.isInteger(runAt)) {
      return { ok: false, error: "runAt must be an integer epoch-ms timestamp" };
    }
    if (runAt <= now) return { ok: false, error: "runAt must be in the future" };
    return { ok: true, value: { goal, kind, runAt, intervalSeconds: null, misfirePolicy: policy } };
  }
  const intervalSeconds = body.intervalSeconds ?? body.interval_seconds;
  if (typeof intervalSeconds !== "number" || !Number.isInteger(intervalSeconds)) {
    return { ok: false, error: "intervalSeconds must be an integer" };
  }
  if (intervalSeconds < SCHEDULE_MIN_INTERVAL_SECONDS || intervalSeconds > SCHEDULE_MAX_INTERVAL_SECONDS) {
    return {
      ok: false,
      error: `intervalSeconds must be between ${SCHEDULE_MIN_INTERVAL_SECONDS} and ${SCHEDULE_MAX_INTERVAL_SECONDS}`,
    };
  }
  return { ok: true, value: { goal, kind, runAt: null, intervalSeconds, misfirePolicy: policy } };
}

export type CreateScheduleResult =
  | { ok: true; schedule: TaskScheduleDto }
  | { ok: false; error: string; code?: "schedule_limit" };

export function createSchedule(
  conversationId: string,
  body: Record<string, unknown>,
  now = Date.now(),
): CreateScheduleResult {
  const parsed = validateScheduleInput(body, now);
  if (!parsed.ok) return parsed;
  const db = handle();
  if (!db) return { ok: false, error: "database unavailable" };
  try {
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM pc_task_schedule WHERE conversation_id = ?")
      .get(conversationId) as { n: number } | null;
    if ((count?.n ?? 0) >= SCHEDULE_MAX_PER_CONVERSATION) {
      return { ok: false, error: `at most ${SCHEDULE_MAX_PER_CONVERSATION} schedules per conversation`, code: "schedule_limit" };
    }
    const scheduleId = newId();
    const nextRunAt = nextScheduleTime(parsed.value, now);
    db.prepare(
      `INSERT INTO pc_task_schedule
         (id, conversation_id, goal, kind, run_at, interval_seconds, next_run_at, enabled,
          misfire_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      scheduleId,
      conversationId,
      parsed.value.goal,
      parsed.value.kind,
      parsed.value.runAt,
      parsed.value.intervalSeconds,
      nextRunAt,
      parsed.value.misfirePolicy,
      now,
      now,
    );
    const created = getSchedule(conversationId, scheduleId);
    return created ? { ok: true, schedule: created } : { ok: false, error: "schedule insert failed" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type UpdateScheduleResult =
  | { ok: true; schedule: TaskScheduleDto }
  | { ok: false; error: string };

/** PATCH:目标/时间规则/启用态/补跑策略。时间规则变更时重算 next_run_at(单一算法)。 */
export function updateSchedule(
  conversationId: string,
  scheduleId: string,
  body: Record<string, unknown>,
  now = Date.now(),
): UpdateScheduleResult {
  const existing = getSchedule(conversationId, scheduleId);
  if (!existing) return { ok: false, error: "not_found" };
  const db = handle();
  if (!db) return { ok: false, error: "database unavailable" };

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  const rawRunAt = body.runAt ?? body.run_at;
  const rawInterval = body.intervalSeconds ?? body.interval_seconds;
  const rawPolicy = body.misfirePolicy ?? body.misfire_policy;
  // 类型不符整单拒绝,不静默忽略(与创建路径同一口径)。
  if (body.goal !== undefined && typeof body.goal !== "string") {
    return { ok: false, error: "goal must be a string" };
  }
  if (rawRunAt !== undefined && typeof rawRunAt !== "number") {
    return { ok: false, error: "runAt must be an integer epoch-ms timestamp" };
  }
  if (rawInterval !== undefined && typeof rawInterval !== "number") {
    return { ok: false, error: "intervalSeconds must be an integer" };
  }
  if (body.kind !== undefined && body.kind !== "once" && body.kind !== "fixed_interval") {
    return { ok: false, error: "kind must be 'once' or 'fixed_interval'" };
  }
  if (rawPolicy !== undefined && rawPolicy !== "skip" && rawPolicy !== "catch_up_once") {
    return { ok: false, error: "misfirePolicy must be 'skip' or 'catch_up_once'" };
  }
  const merged = {
    goal: typeof body.goal === "string" ? body.goal : existing.goal,
    kind:
      body.kind === "once" || body.kind === "fixed_interval" ? body.kind : existing.kind,
    runAt: typeof rawRunAt === "number" ? rawRunAt : existing.runAt,
    intervalSeconds: typeof rawInterval === "number" ? rawInterval : existing.intervalSeconds,
    misfirePolicy:
      rawPolicy === "skip" || rawPolicy === "catch_up_once" ? rawPolicy : existing.misfirePolicy,
  };
  // 只改 goal / enabled / policy 时不算时间规则变更,不重排(next_run_at 保持原样)——
  // 已过期的一次性调度只允许改这些字段,不允许被"顺手"重新排到未来。
  const timeRuleChanged =
    merged.kind !== existing.kind ||
    merged.runAt !== existing.runAt ||
    merged.intervalSeconds !== existing.intervalSeconds;

  let nextRunAt = existing.nextRunAt;
  if (timeRuleChanged) {
    const parsed = validateScheduleInput(merged, now);
    if (!parsed.ok) return parsed;
    nextRunAt = nextScheduleTime(parsed.value, now);
  } else {
    const goal = typeof merged.goal === "string" ? merged.goal.trim() : "";
    if (!goal) return { ok: false, error: "goal is required" };
    if (goal.length > SCHEDULE_GOAL_MAX_LEN) {
      return { ok: false, error: `goal must be at most ${SCHEDULE_GOAL_MAX_LEN} characters` };
    }
    if (merged.misfirePolicy !== "skip" && merged.misfirePolicy !== "catch_up_once") {
      return { ok: false, error: "misfirePolicy must be 'skip' or 'catch_up_once'" };
    }
  }
  const enabled = typeof body.enabled === "boolean" ? body.enabled : existing.enabled;

  try {
    db.prepare(
      `UPDATE pc_task_schedule
         SET goal = ?, kind = ?, run_at = ?, interval_seconds = ?, next_run_at = ?,
             enabled = ?, misfire_policy = ?, updated_at = ?
       WHERE id = ? AND conversation_id = ?`,
    ).run(
      String(merged.goal).trim().slice(0, SCHEDULE_GOAL_MAX_LEN),
      merged.kind,
      merged.kind === "once" ? merged.runAt : null,
      merged.kind === "fixed_interval" ? merged.intervalSeconds : null,
      nextRunAt,
      enabled ? 1 : 0,
      merged.misfirePolicy,
      now,
      scheduleId,
      conversationId,
    );
    const updated = getSchedule(conversationId, scheduleId);
    return updated ? { ok: true, schedule: updated } : { ok: false, error: "not_found" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function deleteSchedule(conversationId: string, scheduleId: string): boolean {
  const db = handle();
  if (!db) return false;
  try {
    const result = db
      .prepare("DELETE FROM pc_task_schedule WHERE id = ? AND conversation_id = ?")
      .run(scheduleId, conversationId);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/** 会话删除流程显式调用:不依赖 ON DELETE CASCADE(pragma 未必开启)。 */
export function deleteSchedulesForConversations(
  db: InstanceType<typeof Database>,
  conversationIds: Iterable<string>,
): void {
  const ids = [...conversationIds];
  if (ids.length === 0) return;
  const statement = db.prepare("DELETE FROM pc_task_schedule WHERE conversation_id = ?");
  for (const conversationId of ids) {
    try {
      statement.run(conversationId);
    } catch {
      // 旧库可能尚无此表:删除会话不应因此失败。
    }
  }
}

/** 到期扫描(tick 用):enabled 且 next_run_at <= now,按到期先后。 */
export function dueSchedules(now: number, limit = 20): TaskScheduleDto[] {
  const db = handle();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT * FROM pc_task_schedule
         WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC, id ASC LIMIT ?`,
      )
      .all(now, limit) as ScheduleRow[];
    return rows.map(toDto);
  } catch {
    return [];
  }
}

/** CAS 领取:仅当记录仍是扫描时看到的那一版(enabled=1 且 next_run_at 未变)才推进。
 *  UPDATE 的 WHERE 自带并发保护,两个 tick 不会重复领取同一条。 */
export function claimScheduleAdvance(
  schedule: TaskScheduleDto,
  advance: { nextRunAt: number; enabled: boolean },
  now: number,
): boolean {
  const db = handle();
  if (!db) return false;
  try {
    const result = db
      .prepare(
        `UPDATE pc_task_schedule
           SET next_run_at = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
      )
      .run(advance.nextRunAt, advance.enabled ? 1 : 0, now, schedule.id, schedule.nextRunAt);
    return result.changes > 0;
  } catch {
    return false;
  }
}

/** run 建立后回写 last_run_*(由 orchestrator 在 beginAgentRun 之后调用)。 */
export function markScheduleRun(scheduleId: string, runId: string, at: number): void {
  const db = handle();
  if (!db) return;
  try {
    db.prepare(
      "UPDATE pc_task_schedule SET last_run_at = ?, last_run_id = ?, updated_at = ? WHERE id = ?",
    ).run(at, runId, at, scheduleId);
  } catch {
    // 调度记录只用于展示与审计,回写失败不影响生成。
  }
}
