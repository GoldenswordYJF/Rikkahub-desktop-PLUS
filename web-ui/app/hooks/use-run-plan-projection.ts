// hooks/use-run-plan-projection.ts — 历史 run 的计划投影读取(O3)
//
// 只读 run 级投影,不依赖当前事件页是否加载到来源;竞态守卫同历史事件:
// 会话/run/重连代次任一变化,旧响应一律丢弃。latest 模式(runId=null)不发请求。
import * as React from "react";

import { ApiError } from "~/services/api";
import { fetchAgentRunProjection } from "~/stores/agent-run-sync";
import type { RunProjectionDto } from "~/types";

export type RunPlanProjectionError = "missing" | "failed" | null;

export interface RunPlanProjectionState {
  runId: string | null;
  projection: RunProjectionDto | null;
  loading: boolean;
  error: RunPlanProjectionError;
  reload: () => void;
}

interface ProjectionData {
  conversationId: string | null;
  runId: string | null;
  projection: RunProjectionDto | null;
  loading: boolean;
  error: RunPlanProjectionError;
}

const EMPTY: ProjectionData = {
  conversationId: null,
  runId: null,
  projection: null,
  loading: false,
  error: null,
};

function errorKind(error: unknown): RunPlanProjectionError {
  return error instanceof ApiError && error.code === 404 ? "missing" : "failed";
}

export function useRunPlanProjection(
  conversationId: string | null,
  runId: string | null,
  epoch: number,
): RunPlanProjectionState {
  const [state, setState] = React.useState<ProjectionData>(EMPTY);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    const requestId = ++requestRef.current;
    if (!conversationId || !runId) {
      setState(EMPTY);
      return;
    }
    // 同一 run 的重连/重试:保留已读到的计划,只在没有数据时显示加载态。
    setState((prev) =>
      prev.conversationId === conversationId && prev.runId === runId
        ? { ...prev, loading: prev.projection === null, error: null }
        : { conversationId, runId, projection: null, loading: true, error: null },
    );
    fetchAgentRunProjection(conversationId, runId)
      .then((projection) => {
        if (requestRef.current !== requestId) return;
        setState({ conversationId, runId, projection, loading: false, error: null });
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        const kind = errorKind(error);
        console.error("Load run plan projection failed:", error);
        setState((prev) =>
          kind === "missing"
            ? { conversationId, runId, projection: null, loading: false, error: kind }
            : {
                conversationId,
                runId,
                projection: prev.conversationId === conversationId && prev.runId === runId ? prev.projection : null,
                loading: false,
                error: kind,
              },
        );
      });
  }, [conversationId, runId, epoch, reloadNonce]);

  const reload = React.useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  const current =
    state.conversationId === conversationId && state.runId === runId
      ? state
      : { ...EMPTY, runId, loading: Boolean(conversationId && runId) };
  return {
    runId: current.runId,
    projection: current.projection,
    loading: current.loading,
    error: current.error,
    reload,
  };
}
