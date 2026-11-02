// lib/agent-run-events 契约(O2):窗口合并只认 seq,断档不猜补,扩展态不再静默截断。
import { describe, expect, test } from "bun:test";

import {
  AGENT_RUN_LIVE_EVENTS_MAX,
  agentRunWindowFromSnapshot,
  appendAgentRunEvent,
  emptyAgentRunWindow,
  filterAgentRunEvents,
  mergeAgentRunEvents,
  prependAgentRunEventPage,
  type AgentRunEventFilter,
} from "~/lib/agent-run-events";
import type { AgentRunEventDto } from "~/types";

function event(seq: number, kind = "round", summary = `e${seq}`): AgentRunEventDto {
  return { seq, at: 1_000 + seq, kind: kind as AgentRunEventDto["kind"], summary, payload: null };
}

describe("事件窗口合并", () => {
  test("按 seq upsert 排序,同 seq 以新到的为准", () => {
    const merged = mergeAgentRunEvents(
      [event(2, "round", "新2"), event(3, "round", "新3")],
      [event(1), event(3, "round", "旧3")],
    );
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(merged[1]!.summary).toBe("新2");
    expect(merged[2]!.summary).toBe("新3");
  });

  test("快照排序并裁到实时窗口,hasMore 标明有更早页", () => {
    const events = Array.from({ length: AGENT_RUN_LIVE_EVENTS_MAX + 1 }, (_, i) => event(i + 1));
    const window = agentRunWindowFromSnapshot(events.reverse(), false);
    expect(window.events).toHaveLength(AGENT_RUN_LIVE_EVENTS_MAX);
    expect(window.events[0]!.seq).toBe(2);
    expect(window.throughSeq).toBe(AGENT_RUN_LIVE_EVENTS_MAX + 1);
    expect(window.hasMore).toBe(true);
    expect(window.extended).toBe(false);
  });

  test("增量:连续追加 applied,重复/回溯 ignored,断档 gap 且窗口不变", () => {
    const base = agentRunWindowFromSnapshot([event(1), event(2)]);
    expect(appendAgentRunEvent(base, event(2)).outcome).toBe("ignored");
    expect(appendAgentRunEvent(base, event(4)).outcome).toBe("gap");
    const appended = appendAgentRunEvent(base, event(3));
    expect(appended.outcome).toBe("applied");
    expect(appended.window.events.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(appended.window.throughSeq).toBe(3);
  });

  test("扩展态(用户加载过更早页)后追加不再按 500 条静默截断", () => {
    const events = Array.from({ length: AGENT_RUN_LIVE_EVENTS_MAX }, (_, i) => event(i + 1));
    const extended = prependAgentRunEventPage(agentRunWindowFromSnapshot(events), {
      events: [event(0)],
      hasMore: false,
    });
    expect(extended.extended).toBe(true);
    expect(extended.events).toHaveLength(AGENT_RUN_LIVE_EVENTS_MAX + 1);
    const appended = appendAgentRunEvent(extended, event(AGENT_RUN_LIVE_EVENTS_MAX + 1));
    expect(appended.outcome).toBe("applied");
    expect(appended.window.events).toHaveLength(AGENT_RUN_LIVE_EVENTS_MAX + 2);
    expect(appended.window.events[0]!.seq).toBe(0);
  });

  test("加载更早页按 seq 去重并排序,hasMore 采用服务端边界", () => {
    const current = agentRunWindowFromSnapshot([event(3), event(4)]);
    const next = prependAgentRunEventPage(current, {
      events: [event(2), event(3, "round", "重复")],
      hasMore: true,
    });
    expect(next.events.map((item) => item.seq)).toEqual([2, 3, 4]);
    expect(next.events[1]!.summary).toBe("重复");
    expect(next.minSeq).toBe(2);
    expect(next.throughSeq).toBe(4);
    expect(next.hasMore).toBe(true);
  });

  test("空窗口夹一页空事件:清掉 hasMore,不产生幽灵行", () => {
    const current = { ...emptyAgentRunWindow(), hasMore: true };
    const next = prependAgentRunEventPage(current, { events: [], hasMore: false });
    expect(next.events).toEqual([]);
    expect(next.hasMore).toBe(false);
    expect(next.minSeq).toBeNull();
  });
});

describe("事件筛选", () => {
  const events = [
    event(1, "tool_call"),
    event(2, "tool_result"),
    event(3, "approval"),
    event(4, "run_suspended"),
    event(5, "retry"),
    event(6, "replan"),
    event(7, "error"),
    event(8, "stall"),
    event(9, "round"),
  ];
  const seqs = (filter: AgentRunEventFilter) =>
    filterAgentRunEvents(events, filter).map((item) => item.seq);

  test("工具/审批/重试重规划/异常各自成组,all 保持原数组引用", () => {
    expect(filterAgentRunEvents(events, "all")).toBe(events);
    expect(seqs("tools")).toEqual([1, 2]);
    expect(seqs("approval")).toEqual([3, 4]);
    expect(seqs("retry_replan")).toEqual([5, 6]);
    expect(seqs("issues")).toEqual([7, 8]);
  });

  test("tool_execution 属于工具组;boundary 属于审批组(O4 新增 kind 的前置兼容)", () => {
    expect(seqs("tools")).not.toContain(9);
    const withExecution = [...events, event(10, "tool_execution")];
    expect(filterAgentRunEvents(withExecution, "tools").map((item) => item.seq)).toContain(10);

    const withBoundary = [...events, event(11, "boundary")];
    expect(seqs("approval")).toEqual([3, 4]);
    expect(filterAgentRunEvents(withBoundary, "approval").map((item) => item.seq)).toContain(11);
  });
});
