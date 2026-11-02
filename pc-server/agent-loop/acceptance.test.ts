// agent-loop/acceptance.test.ts — 自主循环 S5 mock 端到端验收(plan §6)
//
// 不是再抄一遍单测:这里把三块真实实现串起来——
//   真实 AgentLoopController(S3 判定表) + 真实 runStreamingToolLoop(S4 骨架)
//   + 脚本化假 ProviderRoundAdapter(零网络、零计费)。
// 覆盖:连续同参同输出 → stalled;完成校验(未验证/有证据);denied 工具不自动重试;
// 轮次耗尽 exhausted 时半截产出仍在消息里。状态条/重试/abort 的端到端在
// inference-engine/tool-loop.test.ts 的 S4 段,这里不重复占轮次。
//
// mock.module 纪律同 tool-loop.test.ts:展开真实模块只覆盖副作用出口,避免同一进程里
// 后续测试文件加载 api/logs 时缺导出。
import { describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { runStreamingToolLoop } = await import("../inference-engine/tool-loop");
const { AgentLoopController } = await import("./controller");
const { normalizePlan } = await import("../tools/plan");

import type { GenerationEvent, LoopToolObservation, StreamHooksWithSink } from "../inference-engine/events";
import type { Message } from "../foundation/types";
import type { Plan } from "../tools/plan";

type Adapter = Parameters<typeof runStreamingToolLoop>[0];
type Round = Awaited<ReturnType<Adapter["readRound"]>>;

const assistant = { id: "a1", mcpServers: [] } as never;

function okResponse(): Response {
  return new Response("", { status: 200 });
}

function toolRound(text: string, id: string, name: string, args: Record<string, unknown>): Round {
  return { text, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], replay: null };
}

const noTools = (text: string): Round => ({ text, toolCalls: [], replay: null });

/** 脚本化 adapter:readRound 按顺序吐剧本;fetch 恒成功(网络失败/429 在 S4 测试)。 */
function adapterFor(rounds: Round[]): Adapter {
  let call = 0;
  return {
    providerItem: { id: "p1", name: "AcceptanceProvider" } as never,
    logUrl: "http://acceptance/chat",
    logHeaders: {},
    fetchRound: async () => okResponse(),
    readRound: async () => {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round;
    },
    encodeNextTurn: () => ({ turn: call }),
    logResponseBody: () => "body",
    joinTextWithNewline: false,
    // 循环层建卡并写回 message.parts:验收"终局时半截产出仍在消息里"。
    toolCardsCreatedInStream: false,
    finishReasoningOnFinal: false,
    exhaustedError: "exhausted",
    headerTimeoutMs: () => 0,
  };
}

interface Harness {
  hooks: StreamHooksWithSink;
  message: Message;
}

/** 迷你应用器:与协调器 applyEvent 对工具事件的处理同构(建卡/回填输出),
 *  用来断言"终局时半截产出仍在消息里";其余事件忽略。 */
function applyToMessage(message: Message, event: GenerationEvent) {
  if (event.kind === "tool_call_created") {
    message.parts.push({
      type: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      output: [],
      approvalState: event.approvalState,
    });
    return;
  }
  if (event.kind === "tool_result") {
    message.parts = message.parts.map((part) =>
      part.type === "tool" && part.toolCallId === event.toolCallId ? { ...part, output: event.output } : part,
    );
  }
}

/** 挂一个迷你 sink(模拟协调器的应用器),便于断言进度保留。 */
function harnessFor(
  controller: InstanceType<typeof AgentLoopController>,
  executeTool: StreamHooksWithSink["executeTool"],
): Harness {
  const message = {
    id: "m1",
    role: "ASSISTANT",
    parts: [],
    annotations: [],
    createdAt: 0,
    finishedAt: null,
    modelId: null,
    usage: null,
  } as unknown as Message;
  return {
    message,
    hooks: {
      conversation: { id: "c1", title: "acceptance" },
      node: { id: "n1" },
      message,
      executeTool,
      sink: (event: GenerationEvent) => applyToMessage(message, event),
      onToolRoundEnd: (observations: LoopToolObservation[]) => controller.evaluateToolRound(observations),
      onFinalCandidate: () => controller.evaluateFinal(),
    } as unknown as StreamHooksWithSink,
  };
}

function controllerFor(
  planRef: { plan: Plan | null },
  overrides: Partial<{ stallRepeatLimit: number; maxReplans: number }> = {},
) {
  const stalls: string[] = [];
  const replans: string[] = [];
  const controller = new AgentLoopController(
    {
      maxReplans: overrides.maxReplans ?? 2,
      stallRepeatLimit: overrides.stallRepeatLimit ?? 3,
      sameErrorLimit: 3,
      requireVerifiedCompletion: true,
    },
    {
      readPlan: () => planRef.plan,
      onStall: ({ reason }) => stalls.push(reason),
      onReplan: ({ reason }) => replans.push(reason),
    },
  );
  return { controller, stalls, replans };
}

function v2Plan(status: "pending" | "completed", evidence: string[] = []): Plan {
  return normalizePlan(
    {
      goal: "把验收跑通",
      done_when: ["所有用例通过"],
      boundaries: ["不删测试"],
      steps: [{ id: "s1", content: "执行验收", status, verify: "test", evidence }],
    },
    { trusted: true },
  );
}

describe("S5 验收 — 判定表与骨架真实串联", () => {
  test("§6-4 同参同输出连续 3 次 → stalled;半截工具产出保留在消息里", async () => {
    const planRef = { plan: v2Plan("pending") };
    const { controller, stalls } = controllerFor(planRef);
    const executed: string[] = [];
    const adapter = adapterFor([
      toolRound("", "tc1", "do_it", { command: "ls" }),
      toolRound("", "tc2", "do_it", { command: "ls" }),
      toolRound("", "tc3", "do_it", { command: "ls" }),
    ]);
    adapter.appendSteeringUserTurns = (body, texts) => ({ ...body, injected: texts });
    const { hooks, message } = harnessFor(controller, async (call) => {
      executed.push(call.function.name);
      return { output: [{ type: "text", text: "同样的输出" }] };
    });

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toMatchObject({
      name: "AgentLoopHaltError",
      status: "stalled",
    });
    expect(executed).toHaveLength(3);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain("do_it");
    expect(message.parts.filter((part) => part.type === "tool")).toHaveLength(3);
  });

  test("§6-6/7 completed 但无证据 → 注入一次重采样;仍无进展 → stalled", async () => {
    const planRef = { plan: v2Plan("completed") }; // evidence 为空 = 未验证
    const { controller, stalls } = controllerFor(planRef);
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = adapterFor([noTools("我完成了"), noTools("确实完成了")]);
    adapter.appendSteeringUserTurns = (body, texts) => ({ ...body, injected: texts });
    adapter.fetchRound = async (body) => {
      bodies.push(body);
      return okResponse();
    };
    const { hooks } = harnessFor(controller, async () => ({ output: [] }));

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toMatchObject({
      status: "stalled",
    });
    expect(bodies).toHaveLength(2);
    expect(String((bodies[1]!.injected as string[])[0])).toContain("without tool evidence");
    expect(stalls[0]).toContain("重采样后无进展");
  });

  test("§6-7 补上工具证据后完成校验放行", async () => {
    const planRef = { plan: v2Plan("completed", ["tc1"]) };
    const { controller, stalls } = controllerFor(planRef);
    const adapter = adapterFor([noTools("有证据，完成")]);
    const { hooks } = harnessFor(controller, async () => ({ output: [] }));

    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("有证据，完成");
    expect(stalls).toEqual([]);
  });

  test("§6-9 denied 的工具只执行一次,不自动重试;模型换工具可继续", async () => {
    const { controller } = controllerFor({ plan: null }); // 无计划:判定表不介入工具选择
    const executed: string[] = [];
    const adapter = adapterFor([
      toolRound("", "tc1", "do_it", { path: "a" }),
      toolRound("", "tc2", "do_it", { path: "b" }),
      noTools("换方案完成"),
    ]);
    const { hooks } = harnessFor(controller, async (call) => {
      executed.push(call.function.arguments);
      if (executed.length === 1) {
        return { output: [{ error: "Tool execution denied by user. Reason: no" }] } as never;
      }
      return { output: [{ type: "text", text: "读到内容" }] };
    });

    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("换方案完成");
    expect(executed).toEqual([JSON.stringify({ path: "a" }), JSON.stringify({ path: "b" })]);
  });

  test("§6-10 轮次耗尽 → exhausted;已执行的 256 轮工具产出仍保留", async () => {
    const { controller } = controllerFor({ plan: null });
    const rounds = Array.from({ length: 256 }, (_, index) =>
      toolRound("", `tc${index}`, "do_it", { page: index }),
    );
    const { hooks, message } = harnessFor(controller, async () => ({ output: [] }));

    await expect(runStreamingToolLoop(adapterFor(rounds), {}, assistant, undefined, hooks)).rejects.toMatchObject({
      name: "AgentLoopHaltError",
      status: "exhausted",
    });
    expect(message.parts.filter((part) => part.type === "tool")).toHaveLength(256);
  }, 20_000);
});
