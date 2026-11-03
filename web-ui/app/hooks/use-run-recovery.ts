// hooks/use-run-recovery.ts — 中断 run 的恢复判定读取(生命周期 L2)
//
// 只读服务端判定,前端不自行推断"这条 run 能不能恢复"。调用方只在候选
// (stopped + interrupted)时传 runId;竞态守卫同历史事件:会话/run/重连代次
// 任一变化,旧响应一律丢弃。
import * as React from "react";

import { ApiError } from "~/services/api";
import { fetchAgentRunRecovery } from "~/stores/agent-run-sync";
import type { AgentRunRecoveryDto } from "~/types";

export type RunRecoveryError = "missing" | "failed" | null;

export interface RunRecoveryState {
  runId: string | null;
  recovery: AgentRunRecoveryDto | null;
  loading: boolean;
  error: RunRecoveryError;
  reload: () => void;
}

interface RecoveryData {
  conversationId: string | null;
  runId: string | null;
  recovery: AgentRunRecoveryDto | null;
  loading: boolean;
  error: RunRecoveryError;
}

const EMPTY: RecoveryData = {
  conversationId: null,
  runId: null,
  recovery: null,
  loading: false,
  error: null,
};

function errorKind(error: unknown): RunRecoveryError {
  return error instanceof ApiError && error.code === 404 ? "missing" : "failed";
}

export function useRunRecovery(
  conversationId: string | null,
  runId: string | null,
  epoch: number,
): RunRecoveryState {
  const [state, setState] = React.useState<RecoveryData>(EMPTY);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    const requestId = ++requestRef.current;
    if (!conversationId || !runId) {
      setState(EMPTY);
      return;
    }
    setState((prev) =>
      prev.conversationId === conversationId && prev.runId === runId
        ? { ...prev, loading: prev.recovery === null, error: null }
        : { conversationId, runId, recovery: null, loading: true, error: null },
    );
    fetchAgentRunRecovery(conversationId, runId)
      .then((recovery) => {
        if (requestRef.current !== requestId) return;
        setState({ conversationId, runId, recovery, loading: false, error: null });
      })
      .catch((error) => {
        if (requestRef.current !== requestId) return;
        const kind = errorKind(error);
        console.error("Load run recovery failed:", error);
        setState({ conversationId, runId, recovery: null, loading: false, error: kind });
      });
  }, [conversationId, runId, epoch, reloadNonce]);

  const reload = React.useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  const current =
    state.conversationId === conversationId && state.runId === runId
      ? state
      : { ...EMPTY, runId, loading: Boolean(conversationId && runId) };
  return {
    runId: current.runId,
    recovery: current.recovery,
    loading: current.loading,
    error: current.error,
    reload,
  };
}
