// agent-loop/run-boundary.test.ts — O4 权限边界与审批复盘流水
//
// 钉住:同一快照只写一条 boundary 事件(stage/access/targetScope 不参与去重);
// 审批时点与执行时点分开记;审批决定按 (toolCallId, decision) 去重;
// 拒绝缘由路径脱敏;suspend → resume 从库里补种边界与决定,不重复写。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolBoundarySnapshot } from "../foundation/tool-boundary";
import type { AgentRunTracker } from "./run-tracker";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-run-boundary-"));

const conversations = await import("../conversations");
const {
  activeRunFor,
  beginAgentRun,
  createRunBoundaryObserver,
  initAgentRunBroadcast,
  recordApprovalDecision,
} = await import("./run-tracker");
const {
  approvalDecisionKeysForRun,
  boundarySnapshotsForRun,
  getRun,
  listRunEvents,
} = await import("./run-store");
const { boundaryIdFor } = await import("../foundation/tool-boundary");

const db = conversations.getConversationsDb() ?? conversations.openConversationsDb();
const CONV = `run-boundary-conv-${process.pid}`;
db.prepare(
  "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
).run(CONV);

initAgentRunBroadcast(() => {
  /* 本文件只验证落库,不验证 SSE 帧 */
});

afterAll(() => {
  initAgentRunBroadcast(() => {
    /* 撤掉测试出口 */
  });
  db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
});

function snapshot(overrides: Partial<ToolBoundarySnapshot> = {}): ToolBoundarySnapshot {
  return {
    workspace: { id: "ws-run-boundary", type: "local", root: "/work/run", cwd: "/work/run/sub" },
    permissionPreset: "balanced",
    effectiveWriteScope: "strict",
    sandbox: {
      tier: "off",
      measured: "unknown",
      boundaryActive: false,
      mechanism: "none",
      checkedAt: 500,
    },
    ...overrides,
  };
}

function eventsOf(runId: string, kind: string) {
  return listRunEvents(runId).filter((event) => event.kind === kind);
}

describe("O4 运行流水", () => {
  test("同一快照只写一条 boundary;审批/执行分开记且带使用语境", () => {
    const tracker = beginAgentRun({ conversationId: CONV, nodeId: "n-o4", engine: "chat" })!;
    const observer = createRunBoundaryObserver(tracker);
    const base = snapshot();
    const baseId = boundaryIdFor(base);

    observer({
      toolCallId: "tc-write",
      toolName: "write",
      stage: "approval",
      access: "write",
      targetScope: "outside",
      snapshot: base,
      approval: {
        reasonCode: "outside_workspace_write",
        reasonSummary: "Writes outside the workspace require approval.",
      },
    });
    // 同一快照,不同 stage/access/targetScope:不新增 boundary 定义。
    observer({
      toolCallId: "tc-read",
      toolName: "read",
      stage: "approval",
      access: "read",
      targetScope: "inside",
      snapshot: base,
    });
    observer({
      toolCallId: "tc-write",
      toolName: "write",
      stage: "execution",
      access: "write",
      targetScope: "outside",
      snapshot: base,
    });

    const boundaries = eventsOf(tracker.runId, "boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.payload).toMatchObject({ boundaryId: baseId, permissionPreset: "balanced" });

    const pending = eventsOf(tracker.runId, "approval");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toMatchObject({
      toolCallId: "tc-write",
      decision: "pending",
      stage: "approval",
      boundaryId: baseId,
      access: "write",
      targetScope: "outside",
      reasonCode: "outside_workspace_write",
    });

    const executions = eventsOf(tracker.runId, "tool_execution");
    expect(executions).toHaveLength(1);
    expect(executions[0]!.payload).toMatchObject({
      toolCallId: "tc-write",
      stage: "execution",
      boundaryId: baseId,
      access: "write",
      targetScope: "outside",
    });

    // 权限档变化 → 新 boundary 定义,新执行引用新 id。
    const narrowed = snapshot({ permissionPreset: "confirm_each" });
    observer({
      toolCallId: "tc-write-2",
      toolName: "write",
      stage: "execution",
      access: "write",
      targetScope: "inside",
      snapshot: narrowed,
    });
    expect(eventsOf(tracker.runId, "boundary")).toHaveLength(2);
    expect(eventsOf(tracker.runId, "tool_execution").at(-1)!.payload).toMatchObject({
      boundaryId: boundaryIdFor(narrowed),
    });

    tracker.finishTerminal("succeeded");
  });

  test("审批决定按 (toolCallId, decision) 去重;拒绝缘由路径脱敏", () => {
    const tracker = beginAgentRun({ conversationId: CONV, nodeId: "n-o4-2", engine: "chat" })!;
    const observer = createRunBoundaryObserver(tracker);
    const base = snapshot();
    const baseId = boundaryIdFor(base);

    observer({
      toolCallId: "tc-approve",
      toolName: "bash",
      stage: "approval",
      access: "execute",
      targetScope: "unknown",
      snapshot: base,
      approval: { reasonCode: "destructive_command", reasonSummary: "fork bomb", ruleId: "fork_bomb" },
    });
    // 事件流先报批准
    tracker.observe({ kind: "tool_approval_updated", toolCallId: "tc-approve", approvalState: { type: "approved" } });
    // 端点再报一次同一决定:不重复落库
    recordApprovalDecision(CONV, "tc-approve", true);
    const approved = eventsOf(tracker.runId, "approval").filter(
      (event) => (event.payload as { decision?: string }).decision === "approved",
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]!.payload).toMatchObject({ boundaryId: baseId, stage: "approval" });

    // 拒绝:完整路径只留在审批卡,run 流水只保存脱敏短缘由。
    tracker.noteApprovalDecision("tc-deny", "denied", {
      reason: "Writes outside the workspace: C:\\Users\\ZJW\\secret.txt /etc/passwd",
    });
    tracker.noteApprovalDecision("tc-deny", "denied", {
      reason: "Writes outside the workspace: C:\\Users\\ZJW\\secret.txt /etc/passwd",
    });
    const denied = eventsOf(tracker.runId, "approval").filter(
      (event) => (event.payload as { decision?: string }).decision === "denied",
    );
    expect(denied).toHaveLength(1);
    expect((denied[0]!.payload as { reason?: string }).reason).toBe(
      "Writes outside the workspace: <path> <path>",
    );
    expect(JSON.stringify(denied[0]!.payload)).not.toContain("Users\\ZJW");

    tracker.finishTerminal("succeeded");
  });

  test("suspend → resume 从库里补种边界与决定,不重复写", () => {
    const first = beginAgentRun({ conversationId: CONV, nodeId: "n-o4-3", engine: "chat" })!;
    const base = snapshot();
    const baseId = boundaryIdFor(base);
    createRunBoundaryObserver(first)({
      toolCallId: "tc-suspend",
      toolName: "write",
      stage: "approval",
      access: "write",
      targetScope: "inside",
      snapshot: base,
      approval: { reasonCode: "preset_confirm_each" },
    });
    first.suspend();
    expect(activeRunFor(CONV)).toBeUndefined();
    expect(getRun(first.runId)).toMatchObject({ status: "suspended" });
    expect(boundarySnapshotsForRun(first.runId)[baseId]).toBeDefined();

    // 暂停期间的决定:补记审批时点 boundaryId;双路径调用只记一次。
    const reason = "No: C:\\Work\\run\\secret.txt";
    recordApprovalDecision(CONV, "tc-suspend", false, reason);
    recordApprovalDecision(CONV, "tc-suspend", false, reason);
    const suspendedEvents = eventsOf(first.runId, "approval").filter(
      (event) => (event.payload as { decision?: string }).decision === "denied",
    );
    expect(suspendedEvents).toHaveLength(1);
    expect(suspendedEvents[0]!.payload).toMatchObject({ boundaryId: baseId, stage: "approval" });
    expect(JSON.stringify(suspendedEvents[0]!.payload)).not.toContain("Work\\run");
    expect(approvalDecisionKeysForRun(first.runId).has("tc-suspend\u0000denied")).toBe(true);

    // 接续同一条 run:边界不会再写一条,已记决定也不会再写。
    const resumed = beginAgentRun({
      conversationId: CONV,
      nodeId: "n-o4-3",
      engine: "chat",
      resumeSuspended: true,
    })!;
    expect(resumed.runId).toBe(first.runId);
    createRunBoundaryObserver(resumed)({
      toolCallId: "tc-suspend-2",
      toolName: "read",
      stage: "execution",
      access: "read",
      targetScope: "inside",
      snapshot: base,
    });
    resumed.observe({
      kind: "tool_approval_updated",
      toolCallId: "tc-suspend",
      approvalState: { type: "denied", reason },
    });
    recordApprovalDecision(CONV, "tc-suspend", false, reason);

    expect(eventsOf(first.runId, "boundary")).toHaveLength(1);
    expect(
      eventsOf(first.runId, "approval").filter(
        (event) => (event.payload as { decision?: string }).decision === "denied",
      ),
    ).toHaveLength(1);
    // 执行时点仍单独记账(使用语境不同,不因已有 boundary 定义而丢行)。
    expect(eventsOf(first.runId, "tool_execution")).toHaveLength(1);

    resumed.finishTerminal("succeeded");
  });

  test("observer 适配器吞掉 tracker 异常", () => {
    const broken = {
      observeBoundary() {
        throw new Error("tracker boom");
      },
    } as unknown as AgentRunTracker;
    const observer = createRunBoundaryObserver(broken);
    expect(() =>
      observer({
        toolCallId: "tc-x",
        stage: "execution",
        access: "write",
        targetScope: "inside",
        snapshot: snapshot(),
      }),
    ).not.toThrow();
  });
});
