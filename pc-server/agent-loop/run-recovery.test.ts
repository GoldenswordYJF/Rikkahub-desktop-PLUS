// agent-loop/run-recovery.test.ts — 生命周期 L1:启动收敛与耐久 checkpoint。
import { afterAll, describe, expect, test } from "bun:test";

import { getConversationsDb, openConversationsDb } from "../conversations";
import {
  appendRunEvent,
  getRun,
  insertRun,
  listRunEvents,
  updateRun,
} from "./run-store";
import {
  getRunCheckpoint,
  getRunRecovery,
  reconcileAgentRunsAfterBoot,
} from "./run-recovery";

const db = getConversationsDb() ?? openConversationsDb();
const CONV = `run-recovery-${process.pid}`;

db.prepare(
  "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
).run(CONV);

afterAll(() => {
  db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
});

describe("启动收敛", () => {
  test("running 收敛为 stopped/interrupted;suspended 与终局不动;重复执行幂等", () => {
    insertRun({ id: `${CONV}-empty`, conversationId: CONV, nodeId: "n1", engine: "chat", startedAt: 1 });
    insertRun({ id: `${CONV}-events`, conversationId: CONV, nodeId: "n2", engine: "pi", startedAt: 2 });
    insertRun({ id: `${CONV}-suspended`, conversationId: CONV, nodeId: "n3", engine: "chat", startedAt: 3 });
    insertRun({ id: `${CONV}-done`, conversationId: CONV, nodeId: "n4", engine: "chat", startedAt: 4 });
    appendRunEvent(`${CONV}-events`, "run_started", "开始");
    const last = appendRunEvent(`${CONV}-events`, "round", "第 1 轮")!;
    updateRun(`${CONV}-suspended`, { status: "suspended", phase: "awaiting_approval" });
    updateRun(`${CONV}-done`, { status: "succeeded", endedAt: 500 });

    const first = reconcileAgentRunsAfterBoot(10_000);
    expect(first.runningStopped).toBeGreaterThanOrEqual(2);
    expect(first.suspendedKept).toBeGreaterThanOrEqual(1);

    const empty = getRun(`${CONV}-empty`)!;
    expect(empty).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      endedAt: 10_000,
    });
    expect(empty.resumedFromRunId).toBeNull();
    expect(empty.scheduleId).toBeNull();

    const withEvents = getRun(`${CONV}-events`)!;
    expect(withEvents).toMatchObject({ status: "stopped", endedAt: 10_000 });
    const events = listRunEvents(withEvents.id);
    const restartEvents = events.filter(
      (event) => event.kind === "run_finished" && event.payload && typeof event.payload === "object" &&
        !Array.isArray(event.payload) && event.payload.reason === "process_restart",
    );
    expect(restartEvents).toHaveLength(1);
    expect(getRun(`${CONV}-suspended`)!.status).toBe("suspended");
    expect(getRun(`${CONV}-done`)!).toMatchObject({ status: "succeeded", endedAt: 500 });

    const checkpoint = getRunCheckpoint(withEvents.id);
    expect(checkpoint.throughSeq).toBe(last.seq + 1);
    expect(checkpoint.lastEventAt).toBe(events.at(-1)!.at);

    const second = reconcileAgentRunsAfterBoot(20_000);
    expect(second.runningStopped).toBe(0);
    expect(listRunEvents(withEvents.id).filter((event) => event.kind === "run_finished")).toHaveLength(1);
    expect(getRun(withEvents.id)!.endedAt).toBe(10_000);
  });

  test("恢复判定:忙会话/有效暂停/中断新跑/终局与跨会话拒绝", () => {
    const interrupted = `${CONV}-empty`; // 上个用例已收敛为 stopped/interrupted
    const suspended = `${CONV}-suspended`;
    const done = `${CONV}-done`;

    // 不属于该会话 → null(路由 404)
    expect(getRunRecovery("someone-else", interrupted)).toBeNull();
    expect(getRunRecovery(CONV, "missing-run")).toBeNull();

    // 会话忙:一律 none,哪怕是可恢复的中断 run
    expect(getRunRecovery(CONV, interrupted, { busy: true })).toMatchObject({
      mode: "none",
      reason: "conversation_busy",
    });

    // stopped/interrupted → new_run
    const resumed = getRunRecovery(CONV, interrupted);
    expect(resumed).toMatchObject({ runId: interrupted, mode: "new_run", reason: null });
    expect(resumed!.checkpoint.throughSeq).toBeGreaterThanOrEqual(1);

    // suspended:有 pending 审批 → suspended 续跑;没有 → none
    expect(getRunRecovery(CONV, suspended, { hasPendingApproval: true })).toMatchObject({
      mode: "suspended",
      reason: null,
    });
    expect(getRunRecovery(CONV, suspended, { hasPendingApproval: false })).toMatchObject({
      mode: "none",
      reason: "approval_missing",
    });

    // 已终局 → none,原因带状态
    expect(getRunRecovery(CONV, done)).toMatchObject({ mode: "none", reason: "status_succeeded" });
  });

  test("run 链接字段可空且可落库", () => {
    const id = `${CONV}-linked`;
    expect(insertRun({
      id,
      conversationId: CONV,
      nodeId: null,
      engine: "chat",
      startedAt: 30,
      resumedFromRunId: `${CONV}-empty`,
      scheduleId: "schedule-1",
    })).toBe(true);
    expect(getRun(id)).toMatchObject({
      resumedFromRunId: `${CONV}-empty`,
      scheduleId: "schedule-1",
    });
  });
});
