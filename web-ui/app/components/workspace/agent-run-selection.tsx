// components/workspace/agent-run-selection.tsx — 会话窗格级运行选择(O2)
//
// 选择状态 { mode: "latest" } | { mode: "history", runId } 挂在窗格根部,而不是
// 面板局部、也不是全局唯一槽位:
//  - 面板收起/展开、滚动、筛选都不丢选择;
//  - 两个会话窗格各选各的,互不污染;
//  - 切换会话时回到 latest(刷新后同样),不把上一个会话的 runId 带过来。
//
// O3:PlanPanel 由 Workbench 在窗格外渲染,拿不到 React context。provider 的选择额外
// 发布到按会话 id 索引的共享表,PlanPanel 用它读取「同一窗格选中的 run」;共享表只做
// 镜像,写入仍只发生在窗格 provider。两个会话窗格按 id 隔离,不会互相污染。
import * as React from "react";

export type AgentRunSelection =
  | { mode: "latest" }
  | { mode: "history"; runId: string };

interface AgentRunSelectionContextValue {
  conversationId: string | null;
  selection: AgentRunSelection;
  selectLatest: () => void;
  selectRun: (runId: string) => void;
  /** 定位到当前已加载消息(复用 `?msg=` 聚焦机制);带 toolCallId 时工具卡再居中。
   *  找不到由调用方提示。 */
  locateMessage: (messageId: string, toolCallId?: string) => void;
}

const AgentRunSelectionContext = React.createContext<AgentRunSelectionContextValue | null>(null);

const LATEST_SELECTION: AgentRunSelection = { mode: "latest" };
const sharedSelections = new Map<string, AgentRunSelection>();
const sharedListeners = new Map<string, Set<() => void>>();

function notifyShared(conversationId: string): void {
  const listeners = sharedListeners.get(conversationId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Agent run selection listener error:", error);
    }
  }
}

function publishSelection(conversationId: string | null, selection: AgentRunSelection): void {
  if (!conversationId) return;
  const current = sharedSelections.get(conversationId);
  if (
    current &&
    ((current.mode === "latest" && selection.mode === "latest") ||
      (current.mode === "history" &&
        selection.mode === "history" &&
        current.runId === selection.runId))
  ) {
    return;
  }
  sharedSelections.set(conversationId, selection);
  notifyShared(conversationId);
}

/** 窗格外的读取方(PlanPanel):按会话 id 取同一选择;从未选择过 = latest。 */
export function useSharedAgentRunSelection(conversationId: string | null): AgentRunSelection {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      if (!conversationId) return () => {};
      let listeners = sharedListeners.get(conversationId);
      if (!listeners) {
        listeners = new Set();
        sharedListeners.set(conversationId, listeners);
      }
      listeners.add(onStoreChange);
      return () => {
        listeners!.delete(onStoreChange);
        if (listeners!.size === 0) sharedListeners.delete(conversationId);
      };
    },
    [conversationId],
  );
  const getSnapshot = React.useCallback(
    () => (conversationId ? (sharedSelections.get(conversationId) ?? LATEST_SELECTION) : LATEST_SELECTION),
    [conversationId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 测试专用:清空共享选择与监听。 */
export function resetAgentRunSelectionForTest(): void {
  sharedSelections.clear();
  sharedListeners.clear();
}

interface SelectionState {
  conversationId: string | null;
  selection: AgentRunSelection;
}

export function AgentRunSelectionProvider({
  conversationId,
  onLocateMessage,
  children,
}: {
  conversationId: string | null;
  onLocateMessage?: (messageId: string, toolCallId?: string) => void;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<SelectionState>(() => ({
    conversationId,
    selection: { mode: "latest" },
  }));
  // 会话切换必须在同一帧回到 latest:等 effect 会先拿旧 runId 发一次无意义的历史请求,
  // 并可能把旧会话的选中态闪在标题上。
  if (state.conversationId !== conversationId) {
    setState({ conversationId, selection: { mode: "latest" } });
  }
  const selection: AgentRunSelection =
    state.conversationId === conversationId ? state.selection : LATEST_SELECTION;

  // provider 是共享表的唯一写入方;PlanPanel 在窗格外读它。
  React.useEffect(() => {
    publishSelection(conversationId, selection);
  }, [conversationId, selection]);

  const selectLatest = React.useCallback(() => {
    const next: AgentRunSelection = { mode: "latest" };
    publishSelection(conversationId, next);
    setState({ conversationId, selection: next });
  }, [conversationId]);
  const selectRun = React.useCallback(
    (runId: string) => {
      const next: AgentRunSelection = { mode: "history", runId };
      publishSelection(conversationId, next);
      setState({ conversationId, selection: next });
    },
    [conversationId],
  );
  const locateMessage = React.useCallback(
    (messageId: string, toolCallId?: string) => {
      onLocateMessage?.(messageId, toolCallId);
    },
    [onLocateMessage],
  );

  const value = React.useMemo<AgentRunSelectionContextValue>(
    () => ({ conversationId, selection, selectLatest, selectRun, locateMessage }),
    [conversationId, selection, selectLatest, selectRun, locateMessage],
  );

  return (
    <AgentRunSelectionContext.Provider value={value}>
      {children}
    </AgentRunSelectionContext.Provider>
  );
}

/** 窗格内使用;provider 缺失属于装配错误,直接抛错比静默退回 latest 更好定位。 */
export function useAgentRunSelection(): AgentRunSelectionContextValue {
  const value = React.useContext(AgentRunSelectionContext);
  if (!value) {
    throw new Error("useAgentRunSelection must be used inside AgentRunSelectionProvider");
  }
  return value;
}

/** 窗格外的读取方(O3 PlanPanel 接线过渡期)返回 null,由调用方决定回退策略。 */
export function useAgentRunSelectionOptional(): AgentRunSelectionContextValue | null {
  return React.useContext(AgentRunSelectionContext);
}
