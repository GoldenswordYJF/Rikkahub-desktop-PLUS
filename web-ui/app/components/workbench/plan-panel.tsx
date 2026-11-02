import * as React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router";
import {
  Check,
  CircleAlert,
  CircleDashed,
  CircleDot,
  History,
  Link2,
  ListChecks,
  Loader2,
  LocateFixed,
  Minus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { useConversationStore } from "~/stores/conversation-store";
import { useAgentRunEpoch } from "~/stores/agent-run-sync";
import {
  getLatestPlanEntry,
  planViewFromProjection,
  type RunPlanView,
} from "~/lib/plan-model";
import { isPlanV2, isStepUnverified, planProgress, type PlanStep } from "@server/tools/plan";
import { buildToolCallMessageIndex, shortToolCallId } from "~/lib/agent-run-locate";
import { useRunPlanProjection } from "~/hooks/use-run-plan-projection";
import { useSharedAgentRunSelection } from "~/components/workspace/agent-run-selection";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

// 计划面板:把模型的 update_plan 清单钉在右侧,跟随当前窗格选中的运行。
//
// O3:latest 读「本会话最后一条 update_plan」;历史 run 只读该 run 的投影
// (`/agent-runs/:runId/projection`),不跨 run、不跨窗格。步骤的 evidence 是唯一的
// 「步骤 → 工具」关联:只有模型显式写出的 toolCallId 才出定位 chip,不按数组下标猜。
// 来源/证据的定位与运行面板事件共用 `?msg=&tool=` 机制,落到那张工具卡而不是消息顶部。

const STATUS_ICONS = {
  pending: CircleDashed,
  in_progress: CircleDot,
  completed: Check,
  cancelled: Minus,
} as const;

type ChipState = "visible" | "hidden" | "missing";

const UNAVAILABLE_KEYS = {
  no_plan: "unavailable_no_plan",
  source_missing: "unavailable_source_missing",
  source_ambiguous: "unavailable_source_ambiguous",
  invalid_plan: "unavailable_invalid_plan",
  anchor_missing: "unavailable_anchor_missing",
} as const;

function chipTitle(state: ChipState, t: TFunction<"common">): string {
  if (state === "visible") return t("workbench.plan.locate");
  if (state === "hidden") return t("workbench.plan.not_visible");
  return t("workbench.plan.locate_missing");
}

function ToolCallChip({
  toolCallId,
  state,
  label,
  onLocate,
  t,
}: {
  toolCallId: string;
  state: ChipState;
  label?: string;
  onLocate: () => void;
  t: TFunction<"common">;
}) {
  const clickable = state === "visible";
  const title = chipTitle(state, t);
  return (
    <span className="inline-flex items-center" title={title}>
      <button
        type="button"
        aria-label={title}
        disabled={!clickable}
        onClick={clickable ? onLocate : undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded bg-muted/60 px-1 py-px align-baseline text-[10px] leading-4 outline-none",
          clickable
            ? "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            : "cursor-default text-muted-foreground/60",
        )}
      >
        {label ? <span>{label}</span> : null}
        {clickable ? (
          <LocateFixed aria-hidden className="size-2.5" />
        ) : (
          <CircleAlert aria-hidden className="size-2.5" />
        )}
        <code>{shortToolCallId(toolCallId)}</code>
      </button>
    </span>
  );
}

function PanelStatus({
  icon,
  children,
  action,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon}
      <div className="max-w-full space-y-1 text-xs text-muted-foreground">{children}</div>
      {action}
    </div>
  );
}

function HistoryBadge({ runId, t }: { runId: string; t: TFunction<"common"> }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
      <History aria-hidden className="size-3" />
      <span>{t("workbench.plan.history_badge")}</span>
      <code className="rounded bg-muted/60 px-1 py-px text-[10px]" title={runId}>
        {shortToolCallId(runId, 10)}
      </code>
    </div>
  );
}

function StepEvidence({
  step,
  view,
  latestToolMessages,
  onLocate,
  t,
}: {
  step: PlanStep;
  view: RunPlanView | null;
  latestToolMessages: Map<string, string> | null;
  onLocate: (messageId: string, toolCallId: string) => void;
  t: TFunction<"common">;
}) {
  const evidence = step.evidence ?? [];
  if (evidence.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {t("workbench.plan.evidence")}
      </span>
      {evidence.map((toolCallId) => {
        const location = view?.toolLocations[toolCallId];
        const messageId = view
          ? location?.messageId ?? null
          : latestToolMessages?.get(toolCallId) ?? null;
        const state: ChipState = !messageId
          ? "missing"
          : view
            ? location?.visible
              ? "visible"
              : "hidden"
            : "visible";
        return (
          <ToolCallChip
            key={toolCallId}
            toolCallId={toolCallId}
            state={state}
            t={t}
            onLocate={() => {
              if (messageId) onLocate(messageId, toolCallId);
            }}
          />
        );
      })}
    </div>
  );
}

export function PlanPanel({ conversationId }: { conversationId?: string | null }) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const cid = conversationId ?? null;
  const selection = useSharedAgentRunSelection(cid);
  const historyRunId = selection.mode === "history" ? selection.runId : null;
  const epoch = useAgentRunEpoch(cid);
  const projectionState = useRunPlanProjection(cid, historyRunId, epoch);

  // latest 模式才订阅消息流;历史模式只认该 run 的投影,不让别的 run/别的窗格串进来。
  const detail = useConversationStore((state) =>
    cid && !historyRunId ? (state.entries[cid]?.detail ?? null) : null,
  );
  const latestEntry = React.useMemo(
    () => (historyRunId ? null : getLatestPlanEntry(detail)),
    [detail, historyRunId],
  );
  const latestToolMessages = React.useMemo(
    () => (historyRunId ? null : buildToolCallMessageIndex(detail)),
    [detail, historyRunId],
  );
  const view = React.useMemo(
    () => (historyRunId ? planViewFromProjection(projectionState.projection) : null),
    [historyRunId, projectionState.projection],
  );

  const plan = historyRunId ? (view?.plan ?? null) : (latestEntry?.plan ?? null);
  const v2 = historyRunId ? view?.v2 === true : latestEntry ? isPlanV2(latestEntry.plan) : false;

  const handleLocate = React.useCallback(
    (messageId: string, toolCallId: string) => {
      if (!cid) return;
      navigate(`/c/${cid}?msg=${encodeURIComponent(messageId)}&tool=${encodeURIComponent(toolCallId)}`);
    },
    [cid, navigate],
  );

  if (!cid) {
    return (
      <PanelStatus icon={<ListChecks className="size-6 text-muted-foreground/60" strokeWidth={1.75} />}>
        <p>{t("workbench.plan.empty")}</p>
      </PanelStatus>
    );
  }

  if (!plan) {
    if (historyRunId) {
      if (projectionState.error === "missing") {
        return (
          <PanelStatus icon={<CircleAlert className="size-6 text-muted-foreground/60" strokeWidth={1.75} />}>
            <HistoryBadge runId={historyRunId} t={t} />
            <p>{t("workbench.plan.history_missing")}</p>
          </PanelStatus>
        );
      }
      if (projectionState.loading || (!view && !projectionState.error)) {
        return (
          <PanelStatus icon={<Loader2 className="size-6 animate-spin text-muted-foreground/60" />}>
            <HistoryBadge runId={historyRunId} t={t} />
            <p>{t("workbench.plan.history_loading")}</p>
          </PanelStatus>
        );
      }
      if (projectionState.error === "failed" && !view) {
        return (
          <PanelStatus
            icon={<CircleAlert className="size-6 text-muted-foreground/60" strokeWidth={1.75} />}
            action={
              <Button type="button" size="xs" variant="ghost" onClick={projectionState.reload}>
                <RefreshCw />
                {t("workbench.plan.retry")}
              </Button>
            }
          >
            <HistoryBadge runId={historyRunId} t={t} />
            <p>{t("workbench.plan.history_failed")}</p>
          </PanelStatus>
        );
      }
      const reasonKey = view?.unavailableReason
        ? UNAVAILABLE_KEYS[view.unavailableReason]
        : UNAVAILABLE_KEYS.no_plan;
      return (
        <PanelStatus icon={<ListChecks className="size-6 text-muted-foreground/60" strokeWidth={1.75} />}>
          <HistoryBadge runId={historyRunId} t={t} />
          <p>{t(`workbench.plan.${reasonKey}`)}</p>
        </PanelStatus>
      );
    }
    return (
      <PanelStatus icon={<ListChecks className="size-6 text-muted-foreground/60" strokeWidth={1.75} />}>
        <p>{t("workbench.plan.empty")}</p>
      </PanelStatus>
    );
  }

  const progress = planProgress(plan);
  const pct = (n: number) => (progress.total > 0 ? Math.round((n / progress.total) * 100) : 0);
  const sourceToolCallId = historyRunId
    ? view?.sourceToolCallId ?? null
    : latestEntry?.toolCallId ?? null;
  const sourceLocation = sourceToolCallId
    ? historyRunId
      ? view?.toolLocations[sourceToolCallId]
      : latestEntry?.messageId
        ? { messageId: latestEntry.messageId, visible: true }
        : undefined
    : undefined;
  const sourceState: ChipState | null = sourceToolCallId
    ? sourceLocation
      ? sourceLocation.visible
        ? "visible"
        : "hidden"
      : "missing"
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 truncate text-sm font-medium">
            {plan.title || t("workbench.plan.untitled")}
          </div>
          <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("workbench.plan.progress", {
              done: progress.completed,
              total: progress.total,
            })}
          </div>
        </div>
        {historyRunId ? <HistoryBadge runId={historyRunId} t={t} /> : null}
        {/* 进度条分两段:主色=完成,灰色=取消。只按「已了结」画一整条会让 3/4 的会话
            看起来像 4/4 做完,而取消掉的这一步本来就不该算成绩。 */}
        <div className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct(progress.completed)}%` }}
          />
          <div
            className="h-full bg-muted-foreground/35 transition-[width] duration-300 ease-out"
            style={{ width: `${pct(progress.cancelled)}%` }}
          />
        </div>
        {sourceToolCallId && sourceState ? (
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <Link2 aria-hidden className="size-2.5" />
            <span>{t("workbench.plan.source")}</span>
            <ToolCallChip
              toolCallId={sourceToolCallId}
              state={sourceState}
              t={t}
              onLocate={() => {
                if (sourceLocation) handleLocate(sourceLocation.messageId, sourceToolCallId);
              }}
            />
          </div>
        ) : null}
      </div>

      {plan.goal ? (
        <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground/70">{t("workbench.plan.goal")}：</span>
          {plan.goal}
        </p>
      ) : null}

      {(plan.doneWhen?.length ?? 0) > 0 || (plan.boundaries?.length ?? 0) > 0 ? (
        <details className="shrink-0 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {t("workbench.plan.acceptance")}
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {(plan.doneWhen?.length ?? 0) > 0 ? (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("workbench.plan.done_when")}
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {plan.doneWhen!.map((item, index) => (
                    <li key={`done-${index}-${item}`} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(plan.boundaries?.length ?? 0) > 0 ? (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("workbench.plan.boundaries")}
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {plan.boundaries!.map((item, index) => (
                    <li key={`bound-${index}-${item}`} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {plan.steps.map((step, index) => {
          const Icon = STATUS_ICONS[step.status] ?? CircleDashed;
          const settled = step.status === "completed" || step.status === "cancelled";
          // 未验证只对 v2 计划显示:旧计划没有 evidence 字段,保持原样式不误伤。
          const unverified = v2 && isStepUnverified(step);
          return (
            <li
              key={step.id ?? `${index}-${step.content}`}
              className={cn(
                "rounded-lg px-2 py-1.5 text-xs",
                step.status === "in_progress" && "bg-muted/60",
              )}
            >
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center",
                    step.status === "completed" && "text-primary",
                    step.status === "in_progress" && "text-primary",
                    step.status === "pending" && "text-muted-foreground/70",
                    step.status === "cancelled" && "text-muted-foreground/50",
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span
                      className={cn(
                        "leading-relaxed",
                        settled && "text-muted-foreground/70 line-through",
                      )}
                    >
                      {step.content}
                    </span>
                    {unverified ? (
                      <span
                        className="inline-block shrink-0 rounded border border-amber-500/40 px-1 text-[10px] leading-4 text-amber-600 dark:text-amber-400"
                        title={t("workbench.plan.unverified_hint")}
                      >
                        {t("workbench.plan.unverified")}
                      </span>
                    ) : null}
                    {v2 && (step.attempts ?? 0) > 0 ? (
                      <span className="text-[10px] text-muted-foreground/60">
                        {t("workbench.plan.attempts", { count: step.attempts })}
                      </span>
                    ) : null}
                  </div>
                  {v2 && step.verify ? (
                    <p className="break-words text-[11px] leading-relaxed text-muted-foreground/80">
                      <span className="text-muted-foreground/60">
                        {t("workbench.plan.verify")}：
                      </span>
                      {step.verify}
                    </p>
                  ) : null}
                  {v2 && step.lastError ? (
                    <p className="flex items-start gap-1 break-words text-[11px] leading-relaxed text-warning">
                      <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                      <span>
                        <span className="text-muted-foreground/70">
                          {t("workbench.plan.last_error")}：
                        </span>
                        {step.lastError}
                      </span>
                    </p>
                  ) : null}
                  {v2 ? (
                    <StepEvidence
                      step={step}
                      view={view}
                      latestToolMessages={latestToolMessages}
                      onLocate={handleLocate}
                      t={t}
                    />
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
