// agent-loop/plan-projection.test.ts — O3 run 级计划投影契约
//
// 钉住:来源优先最后一条 update_plan 事件 + 精确 toolCallId 查询;权威 planV2 快照优先;
// 计划事件缺失时才在任务边界内向前兜底;不跨 USER 任务、不搜非选中分支、不猜;
// evidence 定位如实给出 visible;路由校验 run 归属。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-plan-projection-"));

import type { Conversation, Message, MessageNode, MessagePart } from "../foundation/types";
import { boundaryIdFor, type ToolBoundarySnapshot } from "../foundation/tool-boundary";

const conversations = await import("../conversations");
const { registerConversation, configureWorkingSet } = await import("../conversations/working-set");
const { appendRunEvent, insertRun, getRunForConversation, listRunEvents } = await import("./run-store");
const { getRunPlanProjection } = await import("./plan-projection");
const { handleConversationRoutes } = await import("../api/handlers/conversations");

const db = conversations.openConversationsDb();

function seedConversationRow(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

function message(id: string, role: Message["role"], parts: MessagePart[], annotations: Message["annotations"] = []): Message {
  return {
    id,
    role,
    parts,
    annotations,
    createdAt: "2026-11-01T00:00:00",
    finishedAt: null,
    modelId: null,
    usage: null,
    translation: null,
  };
}

function node(id: string, messages: Message[], selectIndex = 0): MessageNode {
  return { id, messages, selectIndex };
}

function userNode(id: string, steered = false): MessageNode {
  return node(id, [
    message(`${id}-m`, "USER", [{ type: "text", text: "hi" }], steered ? [{ type: "steered" }] : []),
  ]);
}

function assistantNode(id: string, parts: MessagePart[]): MessageNode {
  return node(id, [message(`${id}-m`, "ASSISTANT", parts)]);
}

function planInput(goal: string, steps: Array<{ content: string; status: string; evidence?: string[] }>) {
  return {
    title: "目标",
    goal,
    done_when: ["测试通过"],
    boundaries: ["不删测试"],
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`,
      content: step.content,
      status: step.status,
      verify: `check-${index + 1}`,
      evidence: step.evidence ?? [],
    })),
  };
}

function planPart(
  toolCallId: string,
  input: unknown,
  snapshot?: unknown,
): MessagePart {
  return {
    type: "tool",
    toolCallId,
    toolName: "update_plan",
    input: typeof input === "string" ? input : JSON.stringify(input),
    output: snapshot
      ? [{ type: "text", text: "{}", metadata: { planV2: snapshot as never } }]
      : [],
    approvalState: { type: "auto" },
  };
}

function plainToolPart(toolCallId: string, toolName: string): MessagePart {
  return {
    type: "tool",
    toolCallId,
    toolName,
    input: "{}",
    output: [{ type: "text", text: "ok" }],
    approvalState: { type: "auto" },
  };
}

function conversation(id: string, nodes: MessageNode[]): Conversation {
  return {
    id,
    assistantId: "a1",
    title: id,
    systemPrompt: null,
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  };
}

function runFor(conversationId: string, runId: string, nodeId: string | null) {
  insertRun({ id: runId, conversationId, nodeId, engine: "chat", startedAt: 100 });
  return getRunForConversation(conversationId, runId)!;
}

function planEvent(runId: string, toolCallId: string): void {
  appendRunEvent(runId, "tool_call", "调用工具 update_plan", {
    toolCallId,
    toolName: "update_plan",
  });
}

const registry = new Map<string, Conversation>();
function register(conv: Conversation): void {
  seedConversationRow(conv.id);
  registry.set(conv.id, conv);
  registerConversation(conv);
}
configureWorkingSet({
  loadConversation: (conversationId) => registry.get(conversationId),
  isGenerating: () => false,
  hasSseClients: () => false,
  hasDirty: () => false,
});

afterAll(() => {
  db.prepare("DELETE FROM pc_conversation WHERE id LIKE 'proj-%'").run();
});

describe("计划来源:最后一条 update_plan 事件 + 精确 toolCallId", () => {
  test("取最后一次事件,权威 planV2 快照优先于模型 input", () => {
    const nodes = [
      userNode("task"),
      assistantNode("a1", [
        planPart("tc-old", planInput("旧目标", [{ content: "旧步骤", status: "completed" }])),
        planPart(
          "tc-new",
          planInput("新目标(未合并)", [{ content: "实现", status: "completed", evidence: ["tc-work"] }]),
          {
            title: "目标",
            goal: "服务端锁定后的目标",
            done_when: ["测试通过"],
            boundaries: ["不删测试"],
            steps: [
              {
                id: "s1",
                content: "实现",
                status: "completed",
                verify: "check-1",
                evidence: ["tc-work"],
                attempts: 2,
                last_error: "第一次失败",
              },
            ],
          },
        ),
        plainToolPart("tc-work", "read"),
      ]),
    ];
    const conv = conversation("proj-exact", nodes);
    register(conv);
    const run = runFor(conv.id, "run-exact", "a1");
    planEvent(run.id, "tc-old");
    planEvent(run.id, "tc-new");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.unavailableReason).toBeNull();
    expect(projection.plan.sourceToolCallId).toBe("tc-new");
    expect(projection.plan.sourceMessageId).toBe("a1-m");
    expect(projection.plan.v2).toBe(true);
    expect(projection.plan.plan?.goal).toBe("服务端锁定后的目标");
    expect(projection.plan.plan?.steps[0]?.attempts).toBe(2);
    expect(projection.plan.plan?.steps[0]?.last_error).toBe("第一次失败");
    expect(projection.plan.toolLocations["tc-new"]).toEqual({ messageId: "a1-m", visible: true });
    expect(projection.plan.toolLocations["tc-work"]).toEqual({ messageId: "a1-m", visible: true });
  });

  test("工具卡在非选中分支:计划仍可还原,定位如实标 visible=false", () => {
    const selected = message("a1-m0", "ASSISTANT", [{ type: "text", text: "另一分支" }]);
    const other = message("a1-m1", "ASSISTANT", [
      planPart("tc-branch", planInput("分支目标", [{ content: "分支步骤", status: "pending" }])),
    ]);
    const conv = conversation("proj-branch", [userNode("task"), node("a1", [selected, other], 0)]);
    register(conv);
    const run = runFor(conv.id, "run-branch", "a1");
    planEvent(run.id, "tc-branch");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan?.goal).toBe("分支目标");
    expect(projection.plan.sourceMessageId).toBe("a1-m1");
    expect(projection.plan.toolLocations["tc-branch"]).toEqual({ messageId: "a1-m1", visible: false });
  });

  test("事件来源已丢失:不回退旧计划,报 source_missing", () => {
    const conv = conversation("proj-missing", [
      userNode("task"),
      assistantNode("a1", [
        planPart("tc-old", planInput("旧目标", [{ content: "旧步骤", status: "completed" }])),
      ]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-missing", "a1");
    planEvent(run.id, "tc-gone");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan).toBeNull();
    expect(projection.plan.sourceToolCallId).toBe("tc-gone");
    expect(projection.plan.unavailableReason).toBe("source_missing");
  });

  test("同一 toolCallId 出现在两个消息:来源不唯一,报 source_ambiguous", () => {
    const plan = planPart("tc-dup", planInput("重复", [{ content: "步骤", status: "pending" }]));
    const conv = conversation("proj-ambiguous", [
      userNode("task"),
      assistantNode("a1", [plan]),
      assistantNode("a2", [plan]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-ambiguous", "a2");
    planEvent(run.id, "tc-dup");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan).toBeNull();
    expect(projection.plan.unavailableReason).toBe("source_ambiguous");
  });

  test("计划 part 存在但无法解析:报 invalid_plan", () => {
    const conv = conversation("proj-invalid", [
      userNode("task"),
      assistantNode("a1", [planPart("tc-empty", { steps: [] })]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-invalid", "a1");
    planEvent(run.id, "tc-empty");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.unavailableReason).toBe("invalid_plan");
  });
});

describe("无计划事件时的任务边界兜底", () => {
  test("同一任务内向前找到最近权威快照", () => {
    const conv = conversation("proj-fallback", [
      userNode("task"),
      assistantNode("plan-a", [planPart("tc-plan", planInput("任务目标", [{ content: "步骤", status: "in_progress" }]))]),
      assistantNode("run-a", [{ type: "text", text: "继续执行" }]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-fallback", "run-a");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan?.goal).toBe("任务目标");
    expect(projection.plan.sourceToolCallId).toBe("tc-plan");
    expect(projection.plan.sourceMessageId).toBe("plan-a-m");
    expect(projection.plan.unavailableReason).toBeNull();
  });

  test("遇前置非 steering USER 即停:新任务不捡上一任务的计划", () => {
    const conv = conversation("proj-boundary", [
      userNode("task-1"),
      assistantNode("plan-a", [planPart("tc-plan", planInput("上一任务", [{ content: "旧", status: "completed" }]))]),
      userNode("task-2"),
      assistantNode("run-b", [{ type: "text", text: "新任务" }]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-boundary", "run-b");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan).toBeNull();
    expect(projection.plan.unavailableReason).toBe("no_plan");
  });

  test("steering USER 不切任务边界,可继续向前找到计划", () => {
    const conv = conversation("proj-steered", [
      userNode("task"),
      assistantNode("plan-a", [planPart("tc-plan", planInput("任务目标", [{ content: "步骤", status: "pending" }]))]),
      userNode("steer", true),
      assistantNode("run-a", [{ type: "text", text: "继续" }]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-steered", "run-a");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan?.goal).toBe("任务目标");
  });

  test("run 锚点不在会话里:报 anchor_missing,不从会话尾部猜", () => {
    const conv = conversation("proj-anchor", [
      userNode("task"),
      assistantNode("plan-a", [planPart("tc-plan", planInput("任务目标", [{ content: "步骤", status: "pending" }]))]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-anchor", "ghost-node");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.plan).toBeNull();
    expect(projection.plan.unavailableReason).toBe("anchor_missing");
  });
});

describe("旧计划与 evidence 定位", () => {
  test("v1 计划(v2 字段缺失)标记 v2=false", () => {
    const conv = conversation("proj-v1", [
      userNode("task"),
      assistantNode("a1", [
        planPart("tc-v1", { title: "旧", steps: [{ content: "第一步", status: "completed" }] }),
      ]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-v1", "a1");
    planEvent(run.id, "tc-v1");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.unavailableReason).toBeNull();
    expect(projection.plan.v2).toBe(false);
  });

  test("evidence 在两个分支都有时优先选中分支位置", () => {
    const selected = message("a1-m0", "ASSISTANT", [
      planPart("tc-plan", planInput("目标", [{ content: "步骤", status: "completed", evidence: ["tc-work"] }])),
      plainToolPart("tc-work", "bash"),
    ]);
    const other = message("a1-m1", "ASSISTANT", [plainToolPart("tc-work", "bash")]);
    const conv = conversation("proj-evidence", [userNode("task"), node("a1", [selected, other], 0)]);
    register(conv);
    const run = runFor(conv.id, "run-evidence", "a1");
    planEvent(run.id, "tc-plan");

    const projection = getRunPlanProjection(conv, run);
    expect(projection.plan.toolLocations["tc-work"]).toEqual({ messageId: "a1-m0", visible: true });
  });
});

describe("O4 边界定义投影", () => {
  const snapshot: ToolBoundarySnapshot = {
    workspace: { id: "ws-proj", type: "local", root: "/work/proj", cwd: "/work/proj" },
    permissionPreset: "balanced",
    effectiveWriteScope: "strict",
    sandbox: {
      tier: "off",
      measured: "unknown",
      boundaryActive: false,
      mechanism: "none",
      checkedAt: 100,
    },
  };

  test("boundaries 从该 run 全部 boundary 事件构建,不依赖已加载事件页", () => {
    const conv = conversation("proj-boundary", [userNode("task")]);
    register(conv);
    const run = runFor(conv.id, "run-boundary", null);
    const boundaryId = boundaryIdFor(snapshot);
    appendRunEvent(run.id, "boundary", "边界 balanced", { boundaryId, ...snapshot });
    // 把 boundary 事件挤出默认页:投影仍应读得到定义。
    for (let index = 0; index < 320; index += 1) {
      appendRunEvent(run.id, "round", `第 ${index + 1} 轮`, { round: index + 1 });
    }
    const loaded = listRunEvents(run.id);
    expect(loaded.some((event) => event.kind === "boundary")).toBe(false);

    const projection = getRunPlanProjection(conv, run);
    expect(projection.boundaries[boundaryId]).toEqual(snapshot);
  });

  test("坏 payload 跳过而不是伪造无边界;同 id 首见即定义", () => {
    const conv = conversation("proj-boundary-bad", [userNode("task")]);
    register(conv);
    const run = runFor(conv.id, "run-boundary-bad", null);
    appendRunEvent(run.id, "boundary", "坏数据", { boundaryId: "b-broken" });
    const boundaryId = boundaryIdFor(snapshot);
    appendRunEvent(run.id, "boundary", "首见", { boundaryId, ...snapshot });
    appendRunEvent(run.id, "boundary", "重复", {
      boundaryId,
      ...snapshot,
      permissionPreset: "full_access",
    });

    const projection = getRunPlanProjection(conv, run);
    expect(projection.boundaries["b-broken"]).toBeUndefined();
    expect(projection.boundaries[boundaryId]).toEqual(snapshot);
  });
});

describe("GET agent-runs/:runId/projection", () => {
  async function call(target: string): Promise<{ status: number; body: any }> {
    const [path, query = ""] = target.split("?");
    const url = new URL(`http://127.0.0.1/api/${path}${query ? `?${query}` : ""}`);
    const response = await handleConversationRoutes(new Request(url), url, path);
    if (!response) throw new Error(`路由未命中: ${target}`);
    return { status: response.status, body: await response.json() };
  }

  test("返回 run 级投影;跨会话/未知 run 一律 404", async () => {
    const conv = conversation("proj-route", [
      userNode("task"),
      assistantNode("a1", [planPart("tc-route", planInput("路由目标", [{ content: "步骤", status: "pending" }]))]),
    ]);
    register(conv);
    const run = runFor(conv.id, "run-route", "a1");
    planEvent(run.id, "tc-route");
    register(conversation("proj-route-other", []));

    const ok = await call("conversations/proj-route/agent-runs/run-route/projection");
    expect(ok.status).toBe(200);
    expect(ok.body.runId).toBe("run-route");
    expect(ok.body.plan.plan.goal).toBe("路由目标");
    expect(ok.body.plan.unavailableReason).toBeNull();

    expect((await call("conversations/proj-route-other/agent-runs/run-route/projection")).status).toBe(404);
    expect((await call("conversations/proj-route/agent-runs/ghost/projection")).status).toBe(404);
  });

  test("只读:读取投影不新增 run/事件行", async () => {
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [count("pc_generation_run"), count("pc_generation_run_event")];
    await call("conversations/proj-route/agent-runs/run-route/projection");
    expect([count("pc_generation_run"), count("pc_generation_run_event")]).toEqual(before);
  });
});
