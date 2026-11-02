// 运行流水的 latest 窗口/历史页竞态契约(O2)
//
// 钉住:
//  - 全量帧整窗替换并推进 windowToken;
//  - 增量断档返回 gap 且不改本地窗口(由 sync 重新 GET);
//  - 重复事件不重复落地;
//  - 重连后旧的“加载更早”响应被 token 拒绝;
//  - 缓存收敛只裁掉用户加载过的旧页,不影响 latest 尾部。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentRunEventDto, AgentRunPushDto, AgentRunSnapshotDto, AgentRunSummary } from "~/types";
import {
  applyAgentRunSnapshot,
  prependConversationAgentRunPage,
  resetConversationStoreForTest,
  setConversationAgentRun,
  trimConversationAgentRunWindow,
  useConversationStore,
} from "~/stores/conversation-store";
import {
  bumpAgentRunEpoch,
  installAgentRunSyncTestSeam,
  resetAgentRunSyncForTest,
  resyncLatestAgentRun,
} from "~/stores/agent-run-sync";
import { AGENT_RUN_LIVE_EVENTS_MAX } from "~/lib/agent-run-events";

function run(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "run-1",
    conversationId: "c",
    nodeId: null,
    engine: "chat",
    status: "running",
    phase: "acting",
    stopReason: null,
    rounds: 0,
    attempts: 0,
    replanCount: 0,
    stallReason: null,
    goal: null,
    startedAt: 1,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

function event(seq: number, summary = `e${seq}`): AgentRunEventDto {
  return { seq, at: 1_000 + seq, kind: "round", summary, payload: null };
}

function push(overrides: Partial<AgentRunPushDto> = {}): AgentRunPushDto {
  return {
    type: "agent_run",
    run: run(),
    event: null,
    events: [event(1), event(2)],
    hasMore: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<AgentRunSnapshotDto> = {}): AgentRunSnapshotDto {
  return {
    run: run(),
    events: [event(1), event(2)],
    hasMore: false,
    nextBeforeSeq: 1,
    throughSeq: 2,
    ...overrides,
  };
}

const runs = () => useConversationStore.getState().agentRuns;

beforeEach(() => {
  resetConversationStoreForTest();
  resetAgentRunSyncForTest();
});

afterEach(() => {
  resetConversationStoreForTest();
  resetAgentRunSyncForTest();
});

describe("latest 实时窗口", () => {
  test("全量帧替换窗口并推进 token;增量连续追加保持 token", () => {
    const entry = runs()["c"];
    expect(entry).toBeUndefined();
    setConversationAgentRun("c", push());
    const first = runs()["c"]!;
    expect(first.windowToken).toBe(1);
    expect(first.events.map((item) => item.seq)).toEqual([1, 2]);

    expect(
      setConversationAgentRun("c", push({ events: undefined, event: event(3), run: run({ rounds: 1 }) })),
    ).toBe("applied");
    const second = runs()["c"]!;
    expect(second.windowToken).toBe(1);
    expect(second.events.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  test("重复/更旧事件 ignored;断档 gap 不改窗口", () => {
    setConversationAgentRun("c", push());
    expect(
      setConversationAgentRun("c", push({ events: undefined, event: event(2) })),
    ).toBe("ignored");
    expect(
      setConversationAgentRun("c", push({ events: undefined, event: event(5) })),
    ).toBe("gap");
    expect(runs()["c"]!.events.map((item) => item.seq)).toEqual([1, 2]);
  });

  test("run.id 变化视为新运行,旧事件不续接", () => {
    setConversationAgentRun("c", push());
    setConversationAgentRun("c", push({ events: undefined, event: event(1), run: run({ id: "run-2" }) }));
    const entry = runs()["c"]!;
    expect(entry.run.id).toBe("run-2");
    expect(entry.events.map((item) => item.seq)).toEqual([1]);
    expect(entry.windowToken).toBe(0);
  });

  test("重连后的旧页响应被 windowToken 拒绝", () => {
    setConversationAgentRun("c", push());
    const oldToken = runs()["c"]!.windowToken;
    // 重连首帧:整窗替换,token 前进
    setConversationAgentRun("c", push({ events: [event(10), event(11)], hasMore: true, run: run({ rounds: 2 }) }));
    const newToken = runs()["c"]!.windowToken;
    expect(newToken).toBe(oldToken + 1);

    expect(
      prependConversationAgentRunPage("c", "run-1", { events: [event(3)], hasMore: true }, oldToken),
    ).toBe(false);
    expect(runs()["c"]!.events.map((item) => item.seq)).toEqual([10, 11]);

    expect(
      prependConversationAgentRunPage("c", "run-1", { events: [event(3)], hasMore: true }, newToken),
    ).toBe(true);
    expect(runs()["c"]!.events.map((item) => item.seq)).toEqual([3, 10, 11]);
  });

  test("历史页不接受错误的 runId", () => {
    setConversationAgentRun("c", push());
    const token = runs()["c"]!.windowToken;
    expect(
      prependConversationAgentRunPage("c", "other-run", { events: [event(0)], hasMore: false }, token),
    ).toBe(false);
  });

  test("后台缓存收敛只裁掉扩展页,保留最新窗口并标记 hasMore", () => {
    const events = Array.from({ length: AGENT_RUN_LIVE_EVENTS_MAX }, (_, i) => event(i + 1));
    setConversationAgentRun("c", push({ events }));
    const token = runs()["c"]!.windowToken;
    prependConversationAgentRunPage("c", "run-1", { events: [event(0)], hasMore: false }, token);
    expect(runs()["c"]!.extended).toBe(true);
    expect(runs()["c"]!.events).toHaveLength(AGENT_RUN_LIVE_EVENTS_MAX + 1);

    trimConversationAgentRunWindow("c");
    const trimmed = runs()["c"]!;
    expect(trimmed.extended).toBe(false);
    expect(trimmed.events).toHaveLength(AGENT_RUN_LIVE_EVENTS_MAX);
    expect(trimmed.events[0]!.seq).toBe(1);
    expect(trimmed.throughSeq).toBe(AGENT_RUN_LIVE_EVENTS_MAX);
    expect(trimmed.hasMore).toBe(true);
  });

  test("run=null 的快照清空 latest 槽位", () => {
    setConversationAgentRun("c", push());
    expect(applyAgentRunSnapshot("c", snapshot({ run: null, events: [] }))).toBe("cleared");
    expect(runs()["c"]).toBeUndefined();
  });
});

describe("缺口重同步", () => {
  test("成功时用最新快照整窗替换", async () => {
    installAgentRunSyncTestSeam({
      fetchSnapshot: async () => snapshot({ events: [event(7), event(8)], hasMore: true }),
    });
    await resyncLatestAgentRun("c");
    expect(runs()["c"]!.events.map((item) => item.seq)).toEqual([7, 8]);
    expect(runs()["c"]!.hasMore).toBe(true);
  });

  test("同代次并发只发一个请求", async () => {
    let calls = 0;
    let resolve!: (value: AgentRunSnapshotDto) => void;
    const pending = new Promise<AgentRunSnapshotDto>((done) => {
      resolve = done;
    });
    installAgentRunSyncTestSeam({
      fetchSnapshot: () => {
        calls += 1;
        return pending;
      },
    });
    const first = resyncLatestAgentRun("c");
    const second = resyncLatestAgentRun("c");
    expect(calls).toBe(1);
    resolve(snapshot());
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  test("代次已前进的迟到响应被丢弃", async () => {
    let resolve!: (value: AgentRunSnapshotDto) => void;
    const pending = new Promise<AgentRunSnapshotDto>((done) => {
      resolve = done;
    });
    installAgentRunSyncTestSeam({ fetchSnapshot: () => pending });
    const inFlight = resyncLatestAgentRun("c");
    bumpAgentRunEpoch("c");
    resolve(snapshot());
    await inFlight;
    expect(runs()["c"]).toBeUndefined();
  });
});
