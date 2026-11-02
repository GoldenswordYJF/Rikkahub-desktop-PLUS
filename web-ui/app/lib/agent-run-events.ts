// lib/agent-run-events.ts — 运行事件窗口的纯函数模型(O2)
//
// 纪律:
//  - 合并只认 (runId, seq)。同一 run 内按 seq upsert + 升序排序,绝不按到达顺序拼接。
//  - 增量断档不猜补:返回 gap,由调用方重新 GET 最新快照(见 stores/agent-run-sync.ts)。
//  - 实时尾部默认只保留固定窗口;用户显式加载过更早页(extended)后不再静默裁剪,
//    否则"加载更早"刚拿到的行会在下一条 SSE 到达时消失。
import type { AgentRunEventDto, AgentRunEventPageDto } from "~/types";

export const AGENT_RUN_LIVE_EVENTS_MAX = 500;

export type AgentRunEventFilter = "all" | "tools" | "approval" | "retry_replan" | "issues";

export interface AgentRunEventWindow {
  events: AgentRunEventDto[];
  /** 更早处还有事件(服务端窗口或本地窗口裁剪都会把它置真)。 */
  hasMore: boolean;
  /** 已加载最小 seq(“加载更早”的游标)。 */
  minSeq: number | null;
  /** 已加载最大 seq(判断增量是否连续的锚点)。 */
  throughSeq: number | null;
  /** 用户显式加载过更早页:后续实时增量不再裁剪窗口。 */
  extended: boolean;
}

export function emptyAgentRunWindow(): AgentRunEventWindow {
  return { events: [], hasMore: false, minSeq: null, throughSeq: null, extended: false };
}

export function agentRunWindowFromSnapshot(events: readonly AgentRunEventDto[], hasMore = false): AgentRunEventWindow {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const trimmed = sorted.length > AGENT_RUN_LIVE_EVENTS_MAX;
  const window = trimmed ? sorted.slice(-AGENT_RUN_LIVE_EVENTS_MAX) : sorted;
  return {
    events: window,
    hasMore: hasMore || trimmed,
    minSeq: window.length > 0 ? window[0]!.seq : null,
    throughSeq: window.length > 0 ? window[window.length - 1]!.seq : null,
    extended: false,
  };
}

/** 增量落地。gap = 与当前尾部不连续,调用方应重同步而不是把断档静默拼上。 */
export function appendAgentRunEvent(
  current: AgentRunEventWindow,
  event: AgentRunEventDto,
): { window: AgentRunEventWindow; outcome: "applied" | "gap" | "ignored" } {
  if (current.throughSeq !== null && event.seq <= current.throughSeq) {
    return { window: current, outcome: "ignored" };
  }
  if (current.throughSeq !== null && event.seq > current.throughSeq + 1) {
    return { window: current, outcome: "gap" };
  }
  let events = [...current.events, event].sort((a, b) => a.seq - b.seq);
  let hasMore = current.hasMore;
  if (!current.extended && events.length > AGENT_RUN_LIVE_EVENTS_MAX) {
    events = events.slice(-AGENT_RUN_LIVE_EVENTS_MAX);
    hasMore = true;
  }
  return {
    window: {
      events,
      hasMore,
      minSeq: events[0]!.seq,
      throughSeq: event.seq,
      extended: current.extended,
    },
    outcome: "applied",
  };
}

/** 把一页更早事件并入窗口(upsert 去重、seq 排序)。显式加载后 extended=true。 */
export function prependAgentRunEventPage(
  current: AgentRunEventWindow,
  page: Pick<AgentRunEventPageDto, "events" | "hasMore">,
): AgentRunEventWindow {
  if (page.events.length === 0 && !page.hasMore) {
    return { ...current, hasMore: false };
  }
  const merged = mergeAgentRunEvents(page.events, current.events);
  return {
    events: merged,
    hasMore: page.hasMore,
    minSeq: merged.length > 0 ? merged[0]!.seq : null,
    throughSeq: merged.length > 0 ? merged[merged.length - 1]!.seq : null,
    extended: true,
  };
}

/** 按 seq upsert 合并两批事件(后者覆盖同 seq;排序只认 seq)。 */
export function mergeAgentRunEvents(
  incoming: readonly AgentRunEventDto[],
  existing: readonly AgentRunEventDto[],
): AgentRunEventDto[] {
  const bySeq = new Map<number, AgentRunEventDto>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function agentRunEventMatchesFilter(
  event: AgentRunEventDto,
  filter: AgentRunEventFilter,
): boolean {
  if (filter === "all") return true;
  const kind = event.kind as string;
  switch (filter) {
    case "tools":
      return kind === "tool_call" || kind === "tool_result" || kind === "tool_execution";
    case "approval":
      // 边界定义随审批语境一起看:权限档/写范围/系统沙箱是审批复盘的一部分。
      return kind === "approval" || kind === "run_suspended" || kind === "boundary";
    case "retry_replan":
      return kind === "retry" || kind === "replan";
    case "issues":
      return kind === "error" || kind === "stall";
  }
}

export function filterAgentRunEvents(
  events: readonly AgentRunEventDto[],
  filter: AgentRunEventFilter,
): AgentRunEventDto[] {
  if (filter === "all") return events as AgentRunEventDto[];
  return events.filter((event) => agentRunEventMatchesFilter(event, filter));
}
