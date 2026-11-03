// agent-loop/run-recovery.ts — 生命周期 L1:启动收敛、checkpoint 与恢复判定
//
// 纪律:
//  - 启动收敛只在「会话库打开并完成建表后、任何新生成/调度 tick 前」由 bootstrap 调一次。
//    数据目录锁保证单写入进程,启动时的 running 必为上一进程遗留,收成 stopped/interrupted
//    是如实记录,不是猜测。
//  - 恢复判定是纯读:不改 run、不写事件;会话忙/ pending 审批由调用方注入,这里不猜会话状态。
//  - checkpoint 现算不落库:恢复与审计读同一份,不建「检查点表」,不复制事件正文。

import { getConversation, getConversationsDb } from "../conversations";
import { getRunPlanProjection } from "./plan-projection";
import { boundarySnapshotsForRun, getRun } from "./run-store";
import type {
  AgentRunRecoveryDto,
  AgentRunResumeMode,
  AgentRunSummary,
  RunCheckpointDto,
} from "./types";

// DTO 定义在纯类型模块 types.ts(web-ui 只能 import 无 bun 运行时依赖的模块);
// 这里转出,保持恢复模块作为该能力的唯一入口。
export type { AgentRunRecoveryDto, AgentRunResumeMode, RunCheckpointDto };

/** 恢复判定的外部事实,由路由层注入——store 层不猜会话运行态。 */
export interface AgentRunRecoveryContext {
  /** 当前会话已有活动生成(生成中或队列非空)。 */
  busy?: boolean;
  /** 消息流中存在与该 run 对应的 pending 审批。 */
  hasPendingApproval?: boolean;
}

export interface AgentRunReconcileResult {
  /** 本次启动被收敛为 stopped/interrupted 的 running 条数。 */
  runningStopped: number;
  /** 启动时保留的 suspended 条数(不动,等恢复接口验证)。 */
  suspendedKept: number;
}

function planAvailableFor(run: AgentRunSummary): boolean {
  try {
    const conversation = getConversation(run.conversationId);
    if (!conversation) return false;
    return getRunPlanProjection(conversation, run).plan.plan !== null;
  } catch {
    return false;
  }
}

/** 单 run 的 checkpoint:事件 seq/时间直取,计划与边界复用现有投影。 */
export function getRunCheckpoint(runId: string): RunCheckpointDto {
  const empty: RunCheckpointDto = { throughSeq: 0, lastEventAt: null, planAvailable: false, boundaryCount: 0 };
  let handle;
  try {
    handle = getConversationsDb();
  } catch {
    return empty;
  }
  if (!handle) return empty;
  try {
    const last = handle
      .prepare("SELECT seq, at FROM pc_generation_run_event WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as { seq: number; at: number } | null;
    const run = getRun(runId);
    return {
      throughSeq: last?.seq ?? 0,
      lastEventAt: last?.at ?? null,
      planAvailable: run ? planAvailableFor(run) : false,
      boundaryCount: Object.keys(boundarySnapshotsForRun(runId)).length,
    };
  } catch {
    return empty;
  }
}

/** 启动收敛(plan §2.2):running → stopped/interrupted;同一事务更新 run 并补终局事件;
 *  已有 reason=process_restart 事件的不重复写;suspended 与终局不动。幂等,可重复调用。 */
export function reconcileAgentRunsAfterBoot(now = Date.now()): AgentRunReconcileResult {
  const none: AgentRunReconcileResult = { runningStopped: 0, suspendedKept: 0 };
  let handle;
  try {
    handle = getConversationsDb();
  } catch {
    return none;
  }
  if (!handle) return none;

  const hasRestartEvent = (runId: string): boolean => {
    const rows = handle
      .prepare("SELECT payload FROM pc_generation_run_event WHERE run_id = ? AND kind = 'run_finished'")
      .all(runId) as Array<{ payload: string | null }>;
    return rows.some((row) => {
      if (!row.payload) return false;
      try {
        const parsed = JSON.parse(row.payload) as { reason?: unknown } | null;
        return parsed?.reason === "process_restart";
      } catch {
        return false;
      }
    });
  };

  // WHERE status='running' 让 UPDATE 自带幂等与并发保护:第二次进入 changes=0,直接跳过。
  const converge = handle.transaction((runId: string): boolean => {
    const result = handle
      .prepare(
        "UPDATE pc_generation_run SET status = 'stopped', stop_reason = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(now, runId);
    if (result.changes === 0) return false;
    if (!hasRestartEvent(runId)) {
      const seqRow = handle
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM pc_generation_run_event WHERE run_id = ?")
        .get(runId) as { seq: number } | null;
      handle
        .prepare(
          "INSERT INTO pc_generation_run_event (run_id, seq, at, kind, summary, payload) VALUES (?, ?, ?, 'run_finished', ?, ?)",
        )
        .run(
          runId,
          seqRow?.seq ?? 1,
          now,
          "已停止(进程重启,任务中断)",
          JSON.stringify({ status: "stopped", reason: "process_restart" }),
        );
    }
    return true;
  });

  let runningStopped = 0;
  try {
    const running = handle
      .prepare("SELECT id FROM pc_generation_run WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    for (const row of running) {
      try {
        if (converge(row.id)) runningStopped += 1;
      } catch (err) {
        // 单条失败不拖累其余收敛,更不阻塞启动。
        console.error(`[agent-loop] 启动收敛失败(run=${row.id},不阻塞启动):`, err);
      }
    }
    const suspended = handle
      .prepare("SELECT COUNT(*) AS n FROM pc_generation_run WHERE status = 'suspended'")
      .get() as { n: number } | null;
    return { runningStopped, suspendedKept: suspended?.n ?? 0 };
  } catch (err) {
    console.error("[agent-loop] 启动收敛扫描失败(不阻塞启动):", err);
    return { runningStopped, suspendedKept: 0 };
  }
}

/** 恢复判定(plan §3.1)。返回 null = run 不属于该会话(路由 404)。 */
export function getRunRecovery(
  conversationId: string,
  runId: string,
  context: AgentRunRecoveryContext = {},
): AgentRunRecoveryDto | null {
  const run = getRun(runId);
  if (!run || run.conversationId !== conversationId) return null;
  const checkpoint = getRunCheckpoint(runId);

  if (context.busy === true) {
    return { runId, mode: "none", reason: "conversation_busy", checkpoint };
  }
  if (run.status === "suspended") {
    return context.hasPendingApproval === true
      ? { runId, mode: "suspended", reason: null, checkpoint }
      : { runId, mode: "none", reason: "approval_missing", checkpoint };
  }
  if (run.status === "stopped" && run.stopReason === "interrupted") {
    return { runId, mode: "new_run", reason: null, checkpoint };
  }
  return { runId, mode: "none", reason: `status_${run.status}`, checkpoint };
}
