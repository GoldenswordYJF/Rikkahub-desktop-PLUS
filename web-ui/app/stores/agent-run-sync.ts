// stores/agent-run-sync.ts — 运行流水的读取代次与缺口重同步(O2)
//
// 纪律:
//  - 「代次」只在连接首帧/重连时前进(conversation-stream.openStream 调用)。任何在
//    代次前进之前发出的 GET,到达时代次已变 → 丢弃,禁止旧响应覆盖重连后的新窗口。
//  - 增量 seq 与本地尾部不连续时不猜补:重新 GET 最新快照(带窗口信息),整窗替换。
//  - 历史 run 的读取不写入 conversation-store 的 latest 槽位;这里只提供传输与代次,
//    分页状态留在 hooks/use-agent-run-history.ts 的局部状态里。
//  - 测试不得打真实网络:传输函数可注入(installAgentRunSyncTestSeam)。
import * as React from "react";

import api from "~/services/api";
import type {
  AgentRunEventPageDto,
  AgentRunListDto,
  AgentRunRecoveryDto,
  AgentRunSnapshotDto,
  RunProjectionDto,
} from "~/types";
import { applyAgentRunSnapshot } from "~/stores/conversation-store";

const epochs = new Map<string, number>();
const epochListeners = new Map<string, Set<() => void>>();
/** 每会话当前缺口重同步的在途请求代次;同代次重复触发直接复用。 */
const resyncInFlight = new Map<string, number>();

function notifyEpoch(conversationId: string): void {
  const listeners = epochListeners.get(conversationId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Agent run epoch listener error:", error);
    }
  }
}

/** 当前读取代次。重连/重新订阅会前进;历史读取以它作废旧请求。 */
export function agentRunEpoch(conversationId: string): number {
  return epochs.get(conversationId) ?? 0;
}

/** 流开始/重连时调用:作废所有更早发出的分页与快照请求。 */
export function bumpAgentRunEpoch(conversationId: string): number {
  const next = agentRunEpoch(conversationId) + 1;
  epochs.set(conversationId, next);
  resyncInFlight.delete(conversationId);
  notifyEpoch(conversationId);
  return next;
}

export function subscribeAgentRunEpoch(
  conversationId: string,
  listener: () => void,
): () => void {
  let listeners = epochListeners.get(conversationId);
  if (!listeners) {
    listeners = new Set();
    epochListeners.set(conversationId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) epochListeners.delete(conversationId);
  };
}

/** 组件订阅当前代次(重连后让历史 hook 重新校验)。 */
export function useAgentRunEpoch(conversationId: string | null): number {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) =>
      conversationId ? subscribeAgentRunEpoch(conversationId, onStoreChange) : () => {},
    [conversationId],
  );
  const getSnapshot = React.useCallback(
    () => (conversationId ? agentRunEpoch(conversationId) : 0),
    [conversationId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ===== 传输(可注入) =====

const defaultFetchSnapshot = (conversationId: string): Promise<AgentRunSnapshotDto> =>
  api.get<AgentRunSnapshotDto>(`conversations/${conversationId}/agent-run`);
const defaultFetchRunList = (conversationId: string): Promise<AgentRunListDto> =>
  api.get<AgentRunListDto>(`conversations/${conversationId}/agent-runs`);
const defaultFetchEventPage = (
  conversationId: string,
  runId: string,
  beforeSeq?: number | null,
  limit?: number,
): Promise<AgentRunEventPageDto> => {
  const searchParams: Record<string, string | number> = {};
  if (beforeSeq != null) searchParams.beforeSeq = beforeSeq;
  if (limit != null) searchParams.limit = limit;
  return api.get<AgentRunEventPageDto>(
    `conversations/${conversationId}/agent-runs/${encodeURIComponent(runId)}/events`,
    { searchParams },
  );
};

const defaultFetchProjection = (
  conversationId: string,
  runId: string,
): Promise<RunProjectionDto> =>
  api.get<RunProjectionDto>(
    `conversations/${conversationId}/agent-runs/${encodeURIComponent(runId)}/projection`,
  );

// 生命周期 L2:恢复判定只读拉取 + 显式恢复。可恢复性由服务端判定,前端不猜。
const defaultFetchRecovery = (
  conversationId: string,
  runId: string,
): Promise<AgentRunRecoveryDto> =>
  api.get<AgentRunRecoveryDto>(
    `conversations/${conversationId}/agent-runs/${encodeURIComponent(runId)}/recovery`,
  );

const defaultPostResume = (
  conversationId: string,
  runId: string,
): Promise<{ status: string; resumedFromRunId: string }> =>
  api.post<{ status: string; resumedFromRunId: string }>(
    `conversations/${conversationId}/agent-runs/${encodeURIComponent(runId)}/resume`,
    {},
  );

let fetchSnapshot = defaultFetchSnapshot;
let fetchRunList = defaultFetchRunList;
let fetchEventPage = defaultFetchEventPage;
let fetchProjection = defaultFetchProjection;
let fetchRecovery = defaultFetchRecovery;
let postResume = defaultPostResume;

export function fetchAgentRunList(conversationId: string): Promise<AgentRunListDto> {
  return fetchRunList(conversationId);
}

export function fetchAgentRunProjection(
  conversationId: string,
  runId: string,
): Promise<RunProjectionDto> {
  return fetchProjection(conversationId, runId);
}

export function fetchAgentRunRecovery(
  conversationId: string,
  runId: string,
): Promise<AgentRunRecoveryDto> {
  return fetchRecovery(conversationId, runId);
}

export function postAgentRunResume(
  conversationId: string,
  runId: string,
): Promise<{ status: string; resumedFromRunId: string }> {
  return postResume(conversationId, runId);
}

export function fetchAgentRunEventPage(
  conversationId: string,
  runId: string,
  beforeSeq?: number | null,
  limit?: number,
): Promise<AgentRunEventPageDto> {
  return fetchEventPage(conversationId, runId, beforeSeq, limit);
}

/**
 * SSE 增量断档后的重同步:GET 最新快照并整窗替换 latest 槽位。
 * 代次已前进(期间重连过)则丢弃;同一代次只有一个在途请求。
 * 观测失败只记录日志,绝不影响生成/工具执行(本函数调用方均为 fire-and-forget)。
 */
export async function resyncLatestAgentRun(conversationId: string): Promise<void> {
  const epoch = agentRunEpoch(conversationId);
  if (resyncInFlight.get(conversationId) === epoch) return;
  resyncInFlight.set(conversationId, epoch);
  try {
    const snapshot = await fetchSnapshot(conversationId);
    if (agentRunEpoch(conversationId) !== epoch) return;
    applyAgentRunSnapshot(conversationId, snapshot);
  } catch (error) {
    // 断网/服务端未启用开关:保持现有窗口,下一次增量或重连再试。
    console.error("Agent run resync failed:", error);
  } finally {
    if (resyncInFlight.get(conversationId) === epoch) {
      resyncInFlight.delete(conversationId);
    }
  }
}

/** 测试专用:注入脚本化传输。 */
export function installAgentRunSyncTestSeam(seam: {
  fetchSnapshot?: (conversationId: string) => Promise<AgentRunSnapshotDto>;
  fetchRunList?: (conversationId: string) => Promise<AgentRunListDto>;
  fetchEventPage?: (
    conversationId: string,
    runId: string,
    beforeSeq?: number | null,
    limit?: number,
  ) => Promise<AgentRunEventPageDto>;
  fetchProjection?: (conversationId: string, runId: string) => Promise<RunProjectionDto>;
  fetchRecovery?: (conversationId: string, runId: string) => Promise<AgentRunRecoveryDto>;
  postResume?: (
    conversationId: string,
    runId: string,
  ) => Promise<{ status: string; resumedFromRunId: string }>;
}): void {
  if (seam.fetchSnapshot) fetchSnapshot = seam.fetchSnapshot;
  if (seam.fetchRunList) fetchRunList = seam.fetchRunList;
  if (seam.fetchEventPage) fetchEventPage = seam.fetchEventPage;
  if (seam.fetchProjection) fetchProjection = seam.fetchProjection;
  if (seam.fetchRecovery) fetchRecovery = seam.fetchRecovery;
  if (seam.postResume) postResume = seam.postResume;
}

/** 测试专用:清空代次/监听/传输注入。 */
export function resetAgentRunSyncForTest(): void {
  epochs.clear();
  epochListeners.clear();
  resyncInFlight.clear();
  fetchSnapshot = defaultFetchSnapshot;
  fetchRunList = defaultFetchRunList;
  fetchEventPage = defaultFetchEventPage;
  fetchProjection = defaultFetchProjection;
  fetchRecovery = defaultFetchRecovery;
  postResume = defaultPostResume;
}
