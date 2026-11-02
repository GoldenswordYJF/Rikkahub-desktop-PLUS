// hooks/use-agent-run-history.ts — 历史 run 的独立读取(O2)
//
// conversation-store 只保存 latest run 的实时窗口;历史运行列表与分页放在这里,
// 不写全局槽位。竞态纪律:
//  - 每次 effect(会话/run/代次/重试变化)领取请求序号;响应回来序号不符即丢弃,
//    较慢的旧响应永远不能覆盖新页面。
//  - 翻页游标用「当前已加载最小 seq」,不复用可能过期的 nextBeforeSeq。
//  - 重连(代次前进)只重新校验最新一页并合并,不丢用户已加载的更早页;若服务端
//    判定该 run 已不存在(404),状态明确变为 missing,不退回 latest 数据。
import * as React from "react";

import { ApiError } from "~/services/api";
import { mergeAgentRunEvents } from "~/lib/agent-run-events";
import { fetchAgentRunEventPage, fetchAgentRunList } from "~/stores/agent-run-sync";
import type { AgentRunEventDto, AgentRunSummary } from "~/types";

export type AgentRunHistoryError = "missing" | "failed" | null;

export interface AgentRunListState {
  runs: AgentRunSummary[];
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/** 列表随新 run 出现/重连刷新;latestRunId 变化足以覆盖“新 run 开始”。 */
export function useAgentRunList(
  conversationId: string | null,
  latestRunId: string | null,
  epoch: number,
): AgentRunListState {
  const [state, setState] = React.useState<{
    runs: AgentRunSummary[];
    loading: boolean;
    error: boolean;
  }>({ runs: [], loading: false, error: false });
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    const requestId = ++requestRef.current;
    if (!conversationId) {
      setState({ runs: [], loading: false, error: false });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: false }));
    fetchAgentRunList(conversationId)
      .then((data) => {
        if (requestRef.current !== requestId) return;
        setState({ runs: data.runs, loading: false, error: false });
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        console.error("Load agent run list failed:", error);
        setState((prev) => ({ ...prev, loading: false, error: true }));
      });
  }, [conversationId, latestRunId, epoch, reloadNonce]);

  const reload = React.useCallback(() => setReloadNonce((nonce) => nonce + 1), []);
  return { ...state, reload };
}

export interface AgentRunHistoryState {
  runId: string | null;
  events: AgentRunEventDto[];
  hasMore: boolean;
  minSeq: number | null;
  throughSeq: number | null;
  loading: boolean;
  loadingOlder: boolean;
  error: AgentRunHistoryError;
  olderFailed: boolean;
  loadOlder: () => void;
  reload: () => void;
}

interface HistoryData {
  conversationId: string | null;
  runId: string | null;
  events: AgentRunEventDto[];
  hasMore: boolean;
  minSeq: number | null;
  throughSeq: number | null;
  loading: boolean;
  loadingOlder: boolean;
  error: AgentRunHistoryError;
  olderFailed: boolean;
}

const EMPTY_HISTORY: HistoryData = {
  conversationId: null,
  runId: null,
  events: [],
  hasMore: false,
  minSeq: null,
  throughSeq: null,
  loading: false,
  loadingOlder: false,
  error: null,
  olderFailed: false,
};

function errorKind(error: unknown): AgentRunHistoryError {
  return error instanceof ApiError && error.code === 404 ? "missing" : "failed";
}

/** runId=null(latest 模式)时不发请求,返回空状态。 */
export function useAgentRunHistory(
  conversationId: string | null,
  runId: string | null,
  epoch: number,
): AgentRunHistoryState {
  const [state, setState] = React.useState<HistoryData>(EMPTY_HISTORY);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const requestRef = React.useRef(0);
  const olderRequestRef = React.useRef<number | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    const requestId = ++requestRef.current;
    if (!conversationId || !runId) {
      setState(EMPTY_HISTORY);
      return;
    }
    setState((prev) => {
      // 同一 run 的代次重校验:保留已加载的旧页,只重新拉最新一页合并。
      if (prev.conversationId === conversationId && prev.runId === runId) {
        return {
          ...prev,
          loading: prev.events.length === 0,
          loadingOlder: false,
          error: null,
          olderFailed: false,
        };
      }
      return {
        ...EMPTY_HISTORY,
        conversationId,
        runId,
        loading: true,
      };
    });
    fetchAgentRunEventPage(conversationId, runId)
      .then((page) => {
        if (requestRef.current !== requestId) return;
        setState((prev) => {
          if (prev.conversationId !== conversationId || prev.runId !== runId) return prev;
          const merged = mergeAgentRunEvents(page.events, prev.events);
          const existingHasOlder =
            prev.minSeq !== null &&
            page.nextBeforeSeq !== null &&
            prev.minSeq < page.nextBeforeSeq;
          return {
            ...prev,
            events: merged,
            // 已加载过更早页时,最新一页的 hasMore 不代表整体边界;沿用旧页的边界。
            hasMore: existingHasOlder ? prev.hasMore : page.hasMore,
            minSeq: merged.length > 0 ? merged[0]!.seq : null,
            throughSeq: merged.length > 0 ? merged[merged.length - 1]!.seq : null,
            loading: false,
            error: null,
          };
        });
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        console.error("Load agent run history failed:", error);
        setState((prev) => {
          if (prev.conversationId !== conversationId || prev.runId !== runId) return prev;
          const kind = errorKind(error);
          return {
            ...prev,
            loading: false,
            error: kind,
            // 404 是“该 run 已不可用”:旧页也不能继续冒充历史;网络失败则保留可读旧页。
            ...(kind === "missing"
              ? { events: [], hasMore: false, minSeq: null, throughSeq: null }
              : {}),
          };
        });
      });
  }, [conversationId, runId, epoch, reloadNonce]);

  const loadOlder = React.useCallback(() => {
    const current = stateRef.current;
    if (
      !conversationId ||
      !runId ||
      current.conversationId !== conversationId ||
      current.runId !== runId ||
      current.loading ||
      current.loadingOlder ||
      !current.hasMore ||
      current.minSeq === null ||
      // 同一代次的翻页只允许一个在途请求;选择/重连换代后旧 id 自动失配。
      olderRequestRef.current === requestRef.current
    ) {
      return;
    }
    const requestId = requestRef.current;
    const beforeSeq = current.minSeq;
    olderRequestRef.current = requestId;
    setState((prev) =>
      prev.runId === runId ? { ...prev, loadingOlder: true, olderFailed: false } : prev,
    );
    fetchAgentRunEventPage(conversationId, runId, beforeSeq)
      .then((page) => {
        if (requestRef.current !== requestId) return;
        setState((prev) => {
          if (prev.conversationId !== conversationId || prev.runId !== runId) return prev;
          const merged = mergeAgentRunEvents(page.events, prev.events);
          return {
            ...prev,
            events: merged,
            hasMore: page.hasMore,
            minSeq: merged.length > 0 ? merged[0]!.seq : null,
            throughSeq: merged.length > 0 ? merged[merged.length - 1]!.seq : null,
            loadingOlder: false,
            olderFailed: false,
          };
        });
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        console.error("Load older agent run events failed:", error);
        setState((prev) =>
          prev.runId === runId ? { ...prev, loadingOlder: false, olderFailed: true } : prev,
        );
      })
      .finally(() => {
        if (olderRequestRef.current === requestId) olderRequestRef.current = null;
      });
  }, [conversationId, runId]);

  const reload = React.useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return {
    runId,
    events: state.runId === runId ? state.events : [],
    hasMore: state.runId === runId ? state.hasMore : false,
    minSeq: state.runId === runId ? state.minSeq : null,
    throughSeq: state.runId === runId ? state.throughSeq : null,
    loading: state.runId === runId ? state.loading : Boolean(runId),
    loadingOlder: state.runId === runId ? state.loadingOlder : false,
    error: state.runId === runId ? state.error : null,
    olderFailed: state.runId === runId ? state.olderFailed : false,
    loadOlder,
    reload,
  };
}
