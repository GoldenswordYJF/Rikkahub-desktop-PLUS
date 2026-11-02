// tool-loop 骨架单测（P1-5 批A + 批次三 R3-4）：轮次推进 / 工具分发 / pending bail / 超限 /
// 非流式降级 / 文本累积模式 / 建卡模式 / abort 检查(读流后 + 工具执行前,三家统一)。
// mock.module 隔离 addLog(写 state+落盘)与 touchStream(SSE)副作用。
// 注意:bun 的 mock.module 全局生效且跨测试文件不回收,必须展开真实模块只覆盖目标
// 导出,否则同一进程里后续加载 app-config/defaults 等会因缺 defaultRequestStats 而炸。
import { describe, expect, mock, test } from "bun:test";

import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";
import type { StreamHooksWithSink } from "./events";

const logged: unknown[] = [];
mock.module("../api/logs", () => ({ ...actualLogs, addLog: (entry: unknown) => logged.push(entry) }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { runStreamingToolLoop } = await import("./tool-loop");
type Adapter = Parameters<typeof runStreamingToolLoop>[0];
type Round = Awaited<ReturnType<Adapter["readRound"]>>;

const assistant = { id: "a1", mcpServers: [] } as never;

function okResponse(): Response {
  return new Response("", { status: 200 });
}

function hooksFixture(executeTool?: (call: { function: { name: string } }) => Promise<{ output: never[] }>) {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    hooks: {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
      executeTool: executeTool ?? (async () => ({ output: [] })),
    } as unknown as StreamHooksWithSink,
  };
}

function baseAdapter(rounds: Round[]): Adapter {
  let call = 0;
  return {
    providerItem: { id: "p1", name: "TestProvider" } as never,
    logUrl: "http://test/chat",
    logHeaders: {},
    fetchRound: async () => okResponse(),
    readRound: async () => {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round;
    },
    encodeNextTurn: (result, toolResults) => ({ turn: call, resultCount: toolResults.length }),
    logResponseBody: () => "body",
    joinTextWithNewline: false,
    toolCardsCreatedInStream: true,
    finishReasoningOnFinal: false,
    exhaustedError: "exhausted",
    headerTimeoutMs: () => 0,
  };
}

const noTools = (text: string): Round => ({ text, toolCalls: [], replay: null });
const withTool = (text: string, name = "do_it"): Round => ({
  text,
  toolCalls: [{ id: "tc1", name, arguments: "{}" }],
  replay: null,
});

describe("轮次与返回值", () => {
  test("无工具单轮返回文本；空文本兜底 (empty response)", async () => {
    const { hooks } = hooksFixture();
    expect(await runStreamingToolLoop(baseAdapter([noTools("你好")]), {}, assistant, undefined, hooks)).toBe("你好");
    expect(await runStreamingToolLoop(baseAdapter([noTools("")]), {}, assistant, undefined, hooks)).toBe("(empty response)");
  });

  test("工具轮推进：执行工具→encodeNextTurn→下一轮文本返回；文本按模式累积", async () => {
    const executed: string[] = [];
    const { hooks, events } = hooksFixture(async (call) => {
      executed.push(call.function.name);
      return { output: [] };
    });
    const adapter = baseAdapter([withTool("第一轮"), noTools("第二轮")]);
    adapter.joinTextWithNewline = true;
    const encoded: unknown[] = [];
    const origEncode = adapter.encodeNextTurn;
    adapter.encodeNextTurn = (result, toolResults) => {
      encoded.push(toolResults.map((t) => t.call.id));
      return origEncode(result, toolResults);
    };
    const out = await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks);
    expect(out).toBe("第一轮\n第二轮");
    expect(executed).toEqual(["do_it"]);
    expect(encoded).toEqual([["tc1"]]);
    expect(events.some((e) => e.kind === "tool_result" && e.toolCallId === "tc1")).toBe(true);
  });

  test("OpenAI 模式：无换行拼接 + 循环层建卡(tool_call_created)", async () => {
    const { hooks, events } = hooksFixture();
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.toolCardsCreatedInStream = false;
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("AB");
    expect(events.some((e) => e.kind === "tool_call_created" && e.toolCallId === "tc1")).toBe(true);
  });

  test("generationMs:每轮都下沉累计值(无上游 usage 也发),工具执行时间不计入(统计行 token/s 内测反馈)", async () => {
    const { hooks, events } = hooksFixture(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120)); // 模拟耗时工具
      return { output: [] };
    });
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    const wallStarted = Date.now();
    await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks);
    const wallMs = Date.now() - wallStarted;
    const usageEvents = events.filter((e) => e.kind === "usage") as Array<{ usage: { generationMs?: number } }>;
    // 两轮各发一次(rounds 无 usage 字段也要下沉累计值)。
    expect(usageEvents.length).toBe(2);
    const last = usageEvents[usageEvents.length - 1]!.usage.generationMs!;
    const first = usageEvents[0]!.usage.generationMs!;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThanOrEqual(first); // 单调累计
    // 全程含 120ms 工具执行,纯生成(假 readRound 即返)应远小于全程——留宽余量防 CI 抖动。
    expect(last).toBeLessThanOrEqual(Math.max(wallMs - 100, 1));
  });
});

describe("S9 轮边界工具刷新", () => {
  test("工具轮边界调用 refreshTools，返回的新 body 进入下一轮 fetch", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.fetchRound = async (requestBody) => {
      bodies.push(requestBody);
      return okResponse();
    };
    adapter.refreshTools = (body) => ({ ...body, tools: ["mcp__a"] });
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("AB");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.tools).toEqual(["mcp__a"]);
  });

  test("refreshTools 返回 undefined 时沿用原 body;最终文本轮不触发刷新", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    let refreshes = 0;
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.fetchRound = async (requestBody) => {
      bodies.push(requestBody);
      return okResponse();
    };
    adapter.refreshTools = () => {
      refreshes += 1;
      return undefined;
    };
    expect(await runStreamingToolLoop(adapter, { marker: 1 }, assistant, undefined, hooks)).toBe("AB");
    // 只在工具批之后(一次)触发；第二轮无工具调用直接收尾。
    expect(refreshes).toBe(1);
    // undefined = 沿用 encodeNextTurn 的原 body，不被刷新改写。
    expect(bodies[1]).toEqual({ turn: 1, resultCount: 1 });
  });
});

describe("自主循环 S3 判定表接线", () => {
  test("最终轮 halt → 类型化 AgentLoopHaltError(不是普通 Error)", async () => {
    const { hooks } = hooksFixture();
    hooks.onFinalCandidate = () => ({ action: "halt", status: "stalled", reason: "计划未了结" });
    await expect(runStreamingToolLoop(baseAdapter([noTools("半截")]), {}, assistant, undefined, hooks)).rejects.toMatchObject({
      name: "AgentLoopHaltError",
      status: "stalled",
      reason: "计划未了结",
    });
  });

  test("工具轮 halt → 立即中止,不再发起下一轮请求", async () => {
    let fetches = 0;
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return okResponse();
    };
    const { hooks } = hooksFixture();
    hooks.onToolRoundEnd = () => ({ action: "halt", status: "awaiting_user", reason: "同一错误重复" });
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toMatchObject({
      name: "AgentLoopHaltError",
      status: "awaiting_user",
    });
    expect(fetches).toBe(1);
  });

  test("最终轮 inject → 判定提示编码进下一轮请求并重采样,不产用户气泡", async () => {
    let fetches = 0;
    const adapter = baseAdapter([noTools("先说完"), noTools("补完")]);
    adapter.appendSteeringUserTurns = (body, texts) => ({ ...body, injected: texts });
    adapter.fetchRound = async (requestBody) => {
      fetches += 1;
      if (fetches === 2) expect(requestBody.injected).toEqual(["plan not complete"]);
      return okResponse();
    };
    const { hooks, events } = hooksFixture();
    let finals = 0;
    hooks.onFinalCandidate = () => {
      finals += 1;
      return finals === 1 ? { action: "inject", text: "plan not complete" } : { action: "continue" };
    };
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("先说完补完");
    expect(fetches).toBe(2);
    expect(finals).toBe(2);
    // 判定提示只在请求体里,不落 parts(事件流里没有额外 user/文本注入帧)。
    expect(events.some((event) => event.kind === "text_delta" && String(event.text).includes("plan not complete"))).toBe(false);
  });

  test("轮次耗尽且判定表开启 → exhausted 类型化错误(保留内容由协调器收尾)", async () => {
    const { hooks } = hooksFixture();
    hooks.onFinalCandidate = () => ({ action: "continue" });
    await expect(runStreamingToolLoop(baseAdapter([withTool("x")]), {}, assistant, undefined, hooks)).rejects.toMatchObject({
      name: "AgentLoopHaltError",
      status: "exhausted",
    });
  });

  test("未传判定钩子 → 超限仍是旧普通 Error(关闭开关逐字一致)", async () => {
    const { hooks } = hooksFixture();
    await expect(runStreamingToolLoop(baseAdapter([withTool("x")]), {}, assistant, undefined, hooks)).rejects.toThrow("exhausted");
  });
});

describe("审批与异常", () => {
  test("pending 工具整批不执行,返回已累积文本", async () => {
    let executedCount = 0;
    const { hooks } = hooksFixture(async () => {
      executedCount += 1;
      return { output: [] };
    });
    const adapter = baseAdapter([
      { text: "前文", toolCalls: [{ id: "t1", name: "do_it", arguments: "{}" }, { id: "t2", name: "ask_user", arguments: "{}" }], replay: null },
    ]);
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("前文");
    expect(executedCount).toBe(0);
  });

  test("工具执行抛错被包装为错误输出,循环继续", async () => {
    const { hooks, events } = hooksFixture(async () => {
      throw new Error("tool boom");
    });
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("AB");
    const toolResult = events.find((e) => e.kind === "tool_result") as { output: Array<{ type: string }> };
    expect(toolResult.output.length).toBeGreaterThan(0);
  });

  test("MAX_TOOL_STEPS 超限抛 adapter 文案", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([withTool("x")]); // 永远返回工具轮
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("exhausted");
  });

  test("!ok 响应抛 provider 名与状态码,并记错误日志", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => new Response("bad key", { status: 401 });
    logged.length = 0;
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 401");
    expect(logged.some((l) => (l as { ok: boolean }).ok === false)).toBe(true);
  });

  test("R3-4:读流后中止抛 AbortError(三家统一,不再依赖 adapter 开关)", async () => {
    const { hooks } = hooksFixture();
    const controller = new AbortController();
    const adapter = baseAdapter([withTool("x")]);
    adapter.readRound = async () => {
      controller.abort();
      return withTool("x");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, controller.signal, hooks)).rejects.toThrow("Generation stopped");
  });

  test("R3-4:停止后本轮剩余工具不再执行(每迭代前查 abort)", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const { hooks } = hooksFixture(async (call) => {
      executed.push(call.function.name);
      controller.abort(); // 第一个工具执行后用户点停止
      return { output: [] };
    });
    // 一批两个工具:第一个执行后 abort,第二个必须被拦下
    const adapter = baseAdapter([
      { text: "批", toolCalls: [{ id: "t1", name: "tool_a", arguments: "{}" }, { id: "t2", name: "tool_b", arguments: "{}" }], replay: null },
    ]);
    await expect(runStreamingToolLoop(adapter, {}, assistant, controller.signal, hooks)).rejects.toThrow("Generation stopped");
    expect(executed).toEqual(["tool_a"]);
  });
});

describe("非流式降级(OpenAI 能力)", () => {
  test("fetch 失败→降级重试同轮成功;makeBody 生效;sink 收到提示", async () => {
    const { hooks, events } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    const adapter = baseAdapter([noTools("恢复成功")]);
    adapter.nonStreamFallback = {
      makeBody: (b) => ({ ...b, stream: false }),
      connectHint: "\n连接失败重试...",
      interruptHint: "\n中断重试...",
    };
    adapter.fetchRound = async (requestBody) => {
      bodies.push(requestBody);
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error("ECONNRESET");
      return okResponse();
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, assistant, undefined, hooks)).toBe("恢复成功");
    expect(bodies[0]).toEqual({ stream: true });
    expect(bodies[1]!.stream).toBe(false); // makeBody 覆盖 stream
    expect(events.some((e) => e.kind === "reasoning_delta" && String(e.text).includes("连接失败重试"))).toBe(true);
  });

  test("读流中断→降级重试;第二次仍失败则抛出", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.nonStreamFallback = { makeBody: (b) => b, connectHint: "c", interruptHint: "i" };
    adapter.readRound = async () => {
      throw new Error("stream cut");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("stream cut");
  });

  test("无降级能力时 fetch 失败直接抛", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      throw new Error("no fallback");
    };
    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("no fallback");
  });
});

describe("用户级非流式(专题9:助手关闭流式输出)", () => {
  const nsAssistant = { id: "a1", mcpServers: [], streamOutput: false } as never;

  test("每一轮都经 makeNonStreamBody 改造,fetch/read 收到 nonStream=true", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const flags: Array<boolean | undefined> = [];
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.makeNonStreamBody = (b) => ({ ...b, stream: false });
    const origRead = adapter.readRound;
    adapter.fetchRound = async (requestBody, _round, _sig, nonStream) => {
      bodies.push(requestBody);
      flags.push(nonStream);
      return okResponse();
    };
    adapter.readRound = async (response, sig, nonStream) => {
      flags.push(nonStream);
      return origRead(response, sig, nonStream);
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, nsAssistant, undefined, hooks)).toBe("AB");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.stream === false)).toBe(true);
    expect(flags.every((f) => f === true)).toBe(true);
  });

  test("用户非流式时不做降级重试:失败直接抛,不产生额外计费请求", async () => {
    const { hooks } = hooksFixture();
    const adapter = baseAdapter([noTools("x")]);
    adapter.makeNonStreamBody = (b) => b;
    adapter.nonStreamFallback = { makeBody: (b) => b, connectHint: "c", interruptHint: "i" };
    let fetchCalls = 0;
    adapter.fetchRound = async () => {
      fetchCalls += 1;
      throw new Error("boom");
    };
    await expect(runStreamingToolLoop(adapter, {}, nsAssistant, undefined, hooks)).rejects.toThrow("boom");
    expect(fetchCalls).toBe(1);
  });

  test("adapter 未声明 makeNonStreamBody 时开关不生效(照常流式)", async () => {
    const { hooks } = hooksFixture();
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = baseAdapter([noTools("流式")]);
    adapter.fetchRound = async (requestBody, _round, _sig, nonStream) => {
      bodies.push({ ...requestBody, nonStreamFlag: nonStream ?? false });
      return okResponse();
    };
    expect(await runStreamingToolLoop(adapter, { stream: true }, nsAssistant, undefined, hooks)).toBe("流式");
    expect(bodies[0]).toEqual({ stream: true, nonStreamFlag: false });
  });
});

describe("自主循环 S4 传输重试", () => {
  const statuses = (events: Array<Record<string, unknown>>) =>
    events.filter((event) => event.kind === "engine_status").map((event) => event.status as Record<string, unknown>);
  const retryAttempts = (events: Array<Record<string, unknown>>) =>
    statuses(events)
      .filter((status) => status.phase === "retrying")
      .map((status) => status.attempt);

  test("首轮 429(Retry-After:0)→ 退避后成功;轮次不增加,状态条第 2 次后清除", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    let reads = 0;
    let boundaries = 0;
    const roundsSeen: number[] = [];
    const adapter = baseAdapter([noTools("恢复成功")]);
    adapter.fetchRound = async (_body, round) => {
      fetches += 1;
      roundsSeen.push(round);
      if (fetches === 1) return new Response("rate", { status: 429, headers: { "Retry-After": "0" } });
      return okResponse();
    };
    const origRead = adapter.readRound;
    adapter.readRound = (response, sig, nonStream) => {
      reads += 1;
      return origRead(response, sig, nonStream);
    };
    hooks.onRunBoundary = () => {
      boundaries += 1;
    };

    expect(await runStreamingToolLoop(adapter, { stream: true }, assistant, undefined, hooks)).toBe("恢复成功");
    expect(fetches).toBe(2);
    expect(reads).toBe(1); // 只读一次流 = 只有一次可见输出机会
    expect(roundsSeen).toEqual([0, 0]); // 重试不推进 round
    expect(boundaries).toBe(1); // 轮边界只走一次
    expect(statuses(events)).toEqual([
      expect.objectContaining({ busy: true, phase: "retrying", attempt: 2, maxAttempts: 3 }),
      { busy: false },
    ]);
  }, 10_000);

  test("连续 429 超过上限 → 3 次尝试后抛出既有文案,状态条走 2/3、3/3", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow(
      "TestProvider 429: slow down",
    );
    expect(fetches).toBe(3);
    expect(retryAttempts(events)).toEqual([2, 3]);
    expect(statuses(events).at(-1)).toEqual({ busy: false });
  }, 10_000);

  test("配额/计费 429 不重试", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response('{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}', {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 429");
    expect(fetches).toBe(1);
    expect(retryAttempts(events)).toEqual([]);
  });

  test("Retry-After 超过 60s → 不等待直接失败", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response("later", { status: 429, headers: { "Retry-After": "61" } });
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 429");
    expect(fetches).toBe(1);
    expect(retryAttempts(events)).toEqual([]);
  });

  test("退避等待中用户 stop → AbortError,不再发起请求", async () => {
    const controller = new AbortController();
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response("rate", { status: 429, headers: { "Retry-After": "30" } });
    };

    const pending = runStreamingToolLoop(adapter, {}, assistant, controller.signal, hooks);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetches).toBe(1);
    expect(retryAttempts(events)).toEqual([2]); // 已进入第 2 次重试的等待,被 stop 打断
    expect(statuses(events).at(-1)).toEqual({ busy: false });
  }, 10_000);

  test("已执行过工具之后不再传输重试", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([withTool("A"), noTools("B")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      if (fetches === 2) return new Response("rate", { status: 429, headers: { "Retry-After": "0" } });
      return okResponse();
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 429");
    expect(fetches).toBe(2); // 第 1 轮 + 第 2 轮各一次,失败轮没有重试
    expect(retryAttempts(events)).toEqual([]);
  });

  test("读流阶段的失败不触发传输重试,仍走现有非流式降级", async () => {
    const { hooks, events } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.nonStreamFallback = { makeBody: (b) => ({ ...b, stream: false }), connectHint: "c", interruptHint: "i" };
    adapter.fetchRound = async () => {
      fetches += 1;
      return okResponse();
    };
    adapter.readRound = async () => {
      throw new Error("stream cut");
    };

    await expect(runStreamingToolLoop(adapter, { stream: true }, assistant, undefined, hooks)).rejects.toThrow("stream cut");
    expect(fetches).toBe(2); // 流式一次 + 非流式降级一次;没有额外的传输重试
    expect(retryAttempts(events)).toEqual([]);
  });

  test("未开启 transportRetry → 429 直接抛(旧行为逐字一致)", async () => {
    const { hooks, events } = hooksFixture();
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response("rate", { status: 429 });
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 429");
    expect(fetches).toBe(1);
    expect(retryAttempts(events)).toEqual([]);
  });

  test("401 即使开启重试也不重试", async () => {
    const { hooks } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("x")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      return new Response("bad key", { status: 401 });
    };

    await expect(runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).rejects.toThrow("TestProvider 401");
    expect(fetches).toBe(1);
  });

  test("网络瞬断按指数退避重试,第二次成功(1s 后退避)", async () => {
    const { hooks } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("网络恢复")]);
    adapter.fetchRound = async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("ECONNRESET");
      return okResponse();
    };

    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("网络恢复");
    expect(fetches).toBe(2);
  }, 10_000);

  test("响应头超时(内部 AbortError)也按传输失败重试,外部未中止时不误判为用户停止", async () => {
    const { hooks } = hooksFixture();
    hooks.transportRetry = true;
    let fetches = 0;
    const adapter = baseAdapter([noTools("超时恢复")]);
    adapter.headerTimeoutMs = () => 5;
    adapter.fetchRound = async (_body, _round, sig) => {
      fetches += 1;
      if (fetches === 1) {
        return new Promise<Response>((_resolve, reject) => {
          sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return okResponse();
    };

    expect(await runStreamingToolLoop(adapter, {}, assistant, undefined, hooks)).toBe("超时恢复");
    expect(fetches).toBe(2);
  }, 10_000);
});
