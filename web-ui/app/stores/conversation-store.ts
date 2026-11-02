// ===== 会话详情细粒度订阅 store(专题1 D 族终极方案,兼 1.5.0 多标签页地基) =====
//
// 按会话 id 索引的详情状态:每次写入只重建 entries 外壳 + 目标 entry,其它会话的
// entry 引用不变 —— 订阅其它会话的窗格(一级容器/二级会话标签分栏下的各列)零重渲染;
// 订阅
// 单个标量的窄选择器(assistantId/title/systemPrompt 等)在流式内容增量期间选出值
// 不变,zustand 按 Object.is 短路,组件同样零重渲染。这就是"流式重渲染面过大"
// (D 族)的根治:重渲染宽度 = 变更语义宽度。
//
// entries 即缓存(取代原 routes/conversations.tsx 的模块级 detailCache):
// 回访会话首帧直接画缓存内容(不经任何加载态),SSE 连接首帧的全量快照随即静默
// 校正。无人订阅的 entry 以 LRU 上限 20 防内存驻留;被 retain(有活跃订阅)的
// entry 永不淘汰。删除会话时显式 evict;导入/恢复等换库场景的短暂陈旧由快照自愈。
//
// 本模块只做纯状态(可单测);SSE 生命周期/轮询兜底/元数据桥等副作用在
// conversation-stream.ts(它是 retain/release 的唯一调用方)。
import { create } from "zustand";

import { applyNodeUpdate, applyTextDelta, mergeConversationSnapshot, prependOlderNodes, replaceNodesRange } from "~/lib/conversation-sync";
import {
  AGENT_RUN_LIVE_EVENTS_MAX,
  agentRunWindowFromSnapshot,
  appendAgentRunEvent,
  emptyAgentRunWindow,
  prependAgentRunEventPage,
  type AgentRunEventWindow,
} from "~/lib/agent-run-events";
import type { AgentRunEventDto, AgentRunPushDto, AgentRunSnapshotDto, AgentRunSummary, ConversationDto, ConversationNodesPageDto, ConversationNodeUpdateEventDto, ConversationSnapshotMetaEventDto, ConversationTextDeltaEventDto, EngineStatusEventDto } from "~/types";

export interface ConversationEntry {
  /** 最后已知快照(含已应用的流式增量);null = 尚无内容(等快照)。 */
  detail: ConversationDto | null;
  /** SSE 订阅建立中(快照未到)。加载态 = subscribing && detail === null。 */
  subscribing: boolean;
  /** 致命错误(fatal 4xx,不含 404);可自愈错误由 sse() 重连兜底,不进这里。 */
  error: string | null;
}

/** pi 引擎瞬态状态(P5):只存 busy 条目,busy:false 即删键。 */
export type EngineBusyStatus = Extract<EngineStatusEventDto, { busy: true }>;

/** 自主循环运行流水(开关关闭时服务端不推帧,本切片恒为空)。
 *  窗口字段与 SSE 增量共用 lib/agent-run-events 的纯函数模型。 */
export interface ConversationAgentRun extends AgentRunEventWindow {
  run: AgentRunSummary;
  /** 每次全量窗口替换(首帧/重同步/重连)自增;用于作废在途的“加载更早”响应。 */
  windowToken: number;
}

interface ConversationStoreState {
  entries: Record<string, ConversationEntry>;
  /** 按会话的引擎瞬态状态(压缩中/自动重试)。SSE engine-status 帧驱动;不参与
   *  entries 的 LRU/缓存语义(瞬态,断流即清,不值得进快照协商)。 */
  engineStatus: Record<string, EngineBusyStatus>;
  /** 按会话的「本次/最近一次」运行流水(PC 专属自主循环)。同一会话只保留最新 run;
   *  增量帧按 seq 去重追加,连接首帧的全量快照整体替换。 */
  agentRuns: Record<string, ConversationAgentRun>;
}

const CACHE_MAX = 20;

// LRU 簿记(模块级,非渲染状态):cachedOrder 只含 entries 现存 id,旧→新。
// retention 计数由 conversation-stream 的 acquire/release 驱动,被 retain 的 id 不淘汰。
const cachedOrder: string[] = [];
const retention = new Map<string, number>();

function touchLru(id: string): void {
  const index = cachedOrder.indexOf(id);
  if (index >= 0) cachedOrder.splice(index, 1);
  cachedOrder.push(id);
}

function dropLru(id: string): void {
  const index = cachedOrder.indexOf(id);
  if (index >= 0) cachedOrder.splice(index, 1);
}

/** 超限淘汰最久未用且无人 retain 的 entry;无淘汰时返回原对象(不触发订阅)。 */
function evictOverflow(entries: Record<string, ConversationEntry>): Record<string, ConversationEntry> {
  let unretained = cachedOrder.filter((id) => !retention.has(id)).length;
  if (unretained <= CACHE_MAX) return entries;
  const next = { ...entries };
  while (unretained > CACHE_MAX) {
    const victim = cachedOrder.find((id) => !retention.has(id));
    if (victim === undefined) break;
    delete next[victim];
    dropLru(victim);
    unretained -= 1;
  }
  return next;
}

function writeEntry(
  entries: Record<string, ConversationEntry>,
  id: string,
  entry: ConversationEntry,
): Record<string, ConversationEntry> {
  touchLru(id);
  return evictOverflow({ ...entries, [id]: entry });
}

const EMPTY_ENTRY: ConversationEntry = { detail: null, subscribing: false, error: null };

export const useConversationStore = create<ConversationStoreState>(() => ({
  entries: {},
  engineStatus: {},
  agentRuns: {},
}));

/** 快照落地:清错误、结束订阅建立态。窗口化快照(I-2)与本地已加载的更早历史做
 *  可验证前缀合并(见 lib/conversation-sync.ts mergeConversationSnapshot);全量快照
 *  语义不变(合并函数原样采用)。返回失配的陈旧区间(绝对下标 [from, to)),由调用方
 *  (conversation-stream)调度分片重拉修复;null = 无需修复。 */
export function applyConversationSnapshot(
  conversation: ConversationDto,
): { from: number; to: number } | null {
  let staleRange: { from: number; to: number } | null = null;
  useConversationStore.setState((state) => {
    const merge = mergeConversationSnapshot(state.entries[conversation.id]?.detail ?? null, conversation);
    staleRange = merge.staleRange;
    return {
      entries: writeEntry(state.entries, conversation.id, {
        detail: merge.detail,
        subscribing: false,
        error: null,
      }),
    };
  });
  return staleRange;
}

/**
 * 向上翻页分片落地(专题2 I-2)。
 * "no_detail" = 缓存已被淘汰;"stale" = 分片与当前窗口不再紧邻(拼接期间来了新快照
 * 或结构变化)。两者都由调用方(conversation-stream)决定是否重拉。
 */
export function applyConversationNodesPage(
  id: string,
  page: ConversationNodesPageDto,
): "applied" | "stale" | "no_detail" {
  let result: "applied" | "stale" | "no_detail" = "applied";
  useConversationStore.setState((state) => {
    const entry = state.entries[id];
    if (!entry?.detail) {
      result = "no_detail";
      return state;
    }
    const next = prependOlderNodes(entry.detail, page);
    if (next === "stale") {
      result = "stale";
      return state;
    }
    return { entries: writeEntry(state.entries, id, { ...entry, detail: next }) };
  });
  return result;
}

/**
 * 陈旧区间修复分片落地(bug1 根修):把权威节点原地替换进已加载窗口,长度与
 * nodesOffset 不变。"stale" = 分片越界(修复期间窗口漂移),调用方放弃本轮。
 */
export function applyConversationNodesRangeReplace(
  id: string,
  page: ConversationNodesPageDto,
): "applied" | "stale" | "no_detail" {
  let result: "applied" | "stale" | "no_detail" = "applied";
  useConversationStore.setState((state) => {
    const entry = state.entries[id];
    if (!entry?.detail) {
      result = "no_detail";
      return state;
    }
    const next = replaceNodesRange(entry.detail, page);
    if (next === "stale") {
      result = "stale";
      return state;
    }
    return { entries: writeEntry(state.entries, id, { ...entry, detail: next }) };
  });
  return result;
}

/**
 * 流式增量落地(身份保持,见 lib/conversation-sync.ts)。
 * 返回 "no_detail" = 本地尚无快照可打增量,调用方(stream)应重启流拿全量快照
 * (对齐原 useConversationDetail 的 refreshNonce 重订阅语义)。
 */
export function applyConversationNodeUpdate(
  event: ConversationNodeUpdateEventDto,
): "applied" | "no_detail" {
  const id = event.conversationId;
  let result: "applied" | "no_detail" = "applied";
  useConversationStore.setState((state) => {
    const entry = state.entries[id];
    if (!entry?.detail) {
      result = "no_detail";
      return state;
    }
    const next = applyNodeUpdate(entry.detail, event);
    if (next === entry.detail && !entry.subscribing && entry.error === null) return state;
    return {
      entries: writeEntry(state.entries, id, { detail: next, subscribing: false, error: null }),
    };
  });
  return result;
}

/**
 * snapshot_meta 轻量首帧落地(专题2 I-1):协商命中,缓存即最新——只确认订阅建立
 * 并同步生成状态,不动 messages。"no_detail" = 缓存已被淘汰(协商不该发生),调用方
 * 重启流拿全量。
 */
export function applyConversationSnapshotMeta(
  event: ConversationSnapshotMetaEventDto,
): "applied" | "no_detail" {
  const id = event.conversationId;
  let result: "applied" | "no_detail" = "applied";
  useConversationStore.setState((state) => {
    const entry = state.entries[id];
    if (!entry?.detail) {
      result = "no_detail";
      return state;
    }
    const detail = entry.detail;
    const next =
      detail.updateAt === event.updateAt && detail.isGenerating === event.isGenerating
        ? detail
        : { ...detail, updateAt: event.updateAt, isGenerating: event.isGenerating };
    if (next === detail && !entry.subscribing && entry.error === null) return state;
    return {
      entries: writeEntry(state.entries, id, { detail: next, subscribing: false, error: null }),
    };
  });
  return result;
}

/**
 * text_delta 增量帧落地(专题2 H-b)。
 * "no_detail" = 本地无快照可打增量;"resync" = 与服务端分叉(见 applyTextDelta)。
 * 两者都由调用方(conversation-stream)重启流拿全量快照。
 */
export function applyConversationTextDelta(
  event: ConversationTextDeltaEventDto,
): "applied" | "no_detail" | "resync" {
  const id = event.conversationId;
  let result: "applied" | "no_detail" | "resync" = "applied";
  useConversationStore.setState((state) => {
    const entry = state.entries[id];
    if (!entry?.detail) {
      result = "no_detail";
      return state;
    }
    const next = applyTextDelta(entry.detail, event);
    if (next === "resync") {
      result = "resync";
      return state;
    }
    if (next === entry.detail && !entry.subscribing && entry.error === null) return state;
    return {
      entries: writeEntry(state.entries, id, { detail: next, subscribing: false, error: null }),
    };
  });
  return result;
}

/**
 * 轮询兜底快照落地。R7-3 单调守卫:轮询响应可能晚于 SSE 增量到达,旧快照无条件
 * 覆盖会让流式文本闪跳一下(下一帧 SSE 才纠正)。以服务端 updateAt 为单调量:每次
 * 内容变更/流式 chunk 服务端都置 updateAt=Date.now(),且随 node_update 帧同步进本地
 * (见 applyNodeUpdate),更旧即判陈旧丢弃。返回是否接受(调用方据此决定是否广播摘要)。
 */
export function applyPolledConversationSnapshot(conversation: ConversationDto): boolean {
  let accepted = false;
  useConversationStore.setState((state) => {
    const entry = state.entries[conversation.id];
    if (entry?.detail && conversation.updateAt < entry.detail.updateAt) return state;
    accepted = true;
    return {
      entries: writeEntry(state.entries, conversation.id, {
        ...(entry ?? EMPTY_ENTRY),
        detail: conversation,
      }),
    };
  });
  return accepted;
}

export function setConversationSubscribing(id: string, subscribing: boolean): void {
  useConversationStore.setState((state) => {
    const entry = state.entries[id] ?? EMPTY_ENTRY;
    if (entry.subscribing === subscribing) return state;
    return { entries: writeEntry(state.entries, id, { ...entry, subscribing }) };
  });
}

export function setConversationError(id: string, error: string | null): void {
  useConversationStore.setState((state) => {
    const entry = state.entries[id] ?? EMPTY_ENTRY;
    if (entry.error === error) return state;
    return { entries: writeEntry(state.entries, id, { ...entry, error }) };
  });
}

/** pi 引擎瞬态状态落地(SSE engine-status 帧 / 断流清理)。busy:false 删键,幂等。
 *  startedAt 起点保持:服务端帧带的真实起点优先;中间帧(pi 事件桥/进度帧)不带时
 *  继承已有起点,不重置"已处理 xx秒"计时;首见 busy 帧无起点则以到达时刻兜底
 *  (pi 自动压缩无 compress 端点起点,首帧即压缩开始,误差可忽略)。 */
export function setConversationEngineStatus(id: string, status: EngineStatusEventDto): void {
  useConversationStore.setState((state) => {
    if (!status.busy) {
      if (!(id in state.engineStatus)) return state;
      const next = { ...state.engineStatus };
      delete next[id];
      return { engineStatus: next };
    }
    const startedAt = status.startedAt ?? state.engineStatus[id]?.startedAt ?? Date.now();
    return { engineStatus: { ...state.engineStatus, [id]: { ...status, startedAt } } };
  });
}

/** 状态条订阅(窄选择器:仅该会话状态变化才重渲染)。无状态 = undefined(不渲染)。 */
export function useConversationEngineStatus(id: string | null): EngineBusyStatus | undefined {
  return useConversationStore((state) => (id ? state.engineStatus[id] : undefined));
}

// ===== 自主循环运行流水(agent-loop)=====
// 服务端每个事件帧都带「当前 run 摘要 + 本次事件」;连接首帧另带 events 全量。
// 面板只在有活跃订阅时才会有帧,但读的是缓存里的"最近一次运行"——生成结束后
// 面板仍可回看,切会话后由重连首帧的 agent-run 快照重建(见 api/sse.ts)。

/** 实时窗口上限在 lib/agent-run-events;用户显式加载过更早页后不再按窗口裁剪。 */
/** 运行流水按会话缓存的上限:entries 的 LRU 只有 20,这里放宽到 40 防长会话堆积。 */
const AGENT_RUN_CACHE_MAX = 40;

function pruneAgentRuns(
  runs: Record<string, ConversationAgentRun>,
  keepId: string,
): Record<string, ConversationAgentRun> {
  if (Object.keys(runs).length <= AGENT_RUN_CACHE_MAX) return runs;
  const next = { ...runs };
  for (const id of Object.keys(next)) {
    if (Object.keys(next).length <= AGENT_RUN_CACHE_MAX) break;
    if (id !== keepId && !cachedOrder.includes(id)) delete next[id];
  }
  return next;
}

/** agent-run SSE 帧落地。返回:
 *  - applied:已落地;
 *  - gap:增量与当前尾部不连续,调用方应重新 GET 最新快照(不在客户端猜补);
 *  - ignored:重放/更旧的帧,或纯状态帧且无变化。
 *  全量帧(events 存在)整体替换窗口(重连/重同步即清除已加载的更早页);
 *  增量帧按 seq 去重、排序后追加;run.id 变化意味着新一次运行。 */
export function setConversationAgentRun(
  id: string,
  push: AgentRunPushDto,
): "applied" | "gap" | "ignored" {
  let outcome: "applied" | "gap" | "ignored" = "ignored";
  useConversationStore.setState((state) => {
    const current = state.agentRuns[id];
    const sameRun = current !== undefined && current.run.id === push.run.id;
    let next: ConversationAgentRun;
    if (push.events) {
      next = {
        run: push.run,
        ...agentRunWindowFromSnapshot(push.events, push.hasMore ?? false),
        windowToken: (sameRun ? current.windowToken : 0) + 1,
      };
      outcome = "applied";
    } else if (push.event) {
      const base: ConversationAgentRun = sameRun
        ? current
        : { run: push.run, ...emptyAgentRunWindow(), windowToken: 0 };
      const appended = appendAgentRunEvent(base, push.event);
      if (appended.outcome === "gap") {
        outcome = "gap";
        return state;
      }
      if (appended.outcome === "ignored") {
        // 迟到重放:流水不动,但终局状态帧仍可能带来更完整的 run 摘要。
        if (sameRun && current.run === push.run) return state;
        next = { ...base, run: push.run };
      } else {
        next = { ...base, run: push.run, ...appended.window, windowToken: base.windowToken };
      }
      outcome = appended.outcome === "applied" ? "applied" : "ignored";
    } else {
      if (sameRun && current.run === push.run) return state;
      next = sameRun
        ? { ...current, run: push.run }
        : { run: push.run, ...emptyAgentRunWindow(), windowToken: 0 };
      outcome = "applied";
    }
    return {
      agentRuns: pruneAgentRuns({ ...state.agentRuns, [id]: next }, id),
    };
  });
  return outcome;
}

/** GET /agent-run 快照落地(缺口重同步/面板主动拉取)。run=null 表示服务端已无可展示运行。 */
export function applyAgentRunSnapshot(id: string, snapshot: AgentRunSnapshotDto): "applied" | "cleared" {
  if (!snapshot.run) {
    clearConversationAgentRun(id);
    return "cleared";
  }
  setConversationAgentRun(id, {
    type: "agent_run",
    run: snapshot.run,
    event: null,
    events: snapshot.events,
    hasMore: snapshot.hasMore,
    nextBeforeSeq: snapshot.nextBeforeSeq,
    throughSeq: snapshot.throughSeq,
  });
  return "applied";
}

/** 把一页更早事件并入实时窗口。expectedWindowToken 不匹配(期间发生过全量替换)即丢弃,
 *  防止旧请求把已被重连清空的旧页拼回新窗口。 */
export function prependConversationAgentRunPage(
  id: string,
  runId: string,
  page: { events: AgentRunEventDto[]; hasMore: boolean },
  expectedWindowToken: number,
): boolean {
  let applied = false;
  useConversationStore.setState((state) => {
    const current = state.agentRuns[id];
    if (!current || current.run.id !== runId || current.windowToken !== expectedWindowToken) return state;
    applied = true;
    return {
      agentRuns: {
        ...state.agentRuns,
        [id]: { ...current, ...prependAgentRunEventPage(current, page) },
      },
    };
  });
  return applied;
}

export function clearConversationAgentRun(id: string): void {
  useConversationStore.setState((state) => {
    if (!(id in state.agentRuns)) return state;
    const next = { ...state.agentRuns };
    delete next[id];
    return { agentRuns: next };
  });
}

/** 无订阅后的后台缓存收敛:用户加载过的更早页回落到固定窗口,避免把完整事件流
 *  长期留在内存里(重新打开会话后仍可通过“加载更早”补回)。只在 extended 时动作。 */
export function trimConversationAgentRunWindow(id: string): void {
  useConversationStore.setState((state) => {
    const current = state.agentRuns[id];
    if (!current || !current.extended) return state;
    const trimmed = current.events.length > AGENT_RUN_LIVE_EVENTS_MAX;
    const events = trimmed
      ? current.events.slice(-AGENT_RUN_LIVE_EVENTS_MAX)
      : current.events;
    return {
      agentRuns: {
        ...state.agentRuns,
        [id]: {
          ...current,
          events,
          hasMore: current.hasMore || trimmed,
          minSeq: events.length > 0 ? events[0]!.seq : null,
          throughSeq: events.length > 0 ? events[events.length - 1]!.seq : null,
          extended: false,
        },
      },
    };
  });
}

/** 「本次运行」面板订阅(窄选择器:流式正文增量不经过这里)。 */
export function useConversationAgentRun(id: string | null): ConversationAgentRun | undefined {
  return useConversationStore((state) => (id ? state.agentRuns[id] : undefined));
}

/** 删除会话/清库时显式驱逐(原 detailCache.delete + resetDetail 的合并语义)。 */
export function evictConversations(ids: readonly string[]): void {
  useConversationStore.setState((state) => {
    const present = ids.filter(
      (id) => id in state.entries || id in state.engineStatus || id in state.agentRuns,
    );
    if (present.length === 0) return state;
    const next = { ...state.entries };
    const nextStatus = { ...state.engineStatus };
    const nextRuns = { ...state.agentRuns };
    for (const id of present) {
      delete next[id];
      delete nextStatus[id];
      delete nextRuns[id];
      dropLru(id);
    }
    return { entries: next, engineStatus: nextStatus, agentRuns: nextRuns };
  });
}

/** conversation-stream 专用:有活跃订阅的会话不参与 LRU 淘汰。 */
export function retainConversationEntry(id: string): void {
  retention.set(id, (retention.get(id) ?? 0) + 1);
}

/** conversation-stream 专用:最后一个订阅释放后,entry 回归普通 LRU 缓存。 */
export function releaseConversationEntry(id: string): void {
  const count = (retention.get(id) ?? 0) - 1;
  if (count > 0) {
    retention.set(id, count);
    return;
  }
  retention.delete(id);
  useConversationStore.setState((state) => {
    const next = evictOverflow(state.entries);
    return next === state.entries ? state : { entries: next };
  });
}

/** 面板/窄选择器的便捷入口;id 为 null(首页无会话)时恒返回 undefined。 */
export function useConversationEntry(id: string | null): ConversationEntry | undefined {
  return useConversationStore((state) => (id ? state.entries[id] : undefined));
}

/** 测试专用:清空全部状态与 LRU 簿记。 */
export function resetConversationStoreForTest(): void {
  cachedOrder.length = 0;
  retention.clear();
  useConversationStore.setState({ entries: {}, engineStatus: {}, agentRuns: {} });
}
