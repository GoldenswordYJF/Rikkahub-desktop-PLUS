// components/settings/experiments/agent-bot-audit.tsx — 生命周期 L4:运行审计(全局只读)
//
// 纪律:
//  - 只展示服务端摘要,不复制详情模型;点开跳到现有会话(详情仍由运行面板承担)。
//  - 不提供删除/清审计;翻页游标由服务端给出,前端不猜。
//  - 导出走服务端 NDJSON,前端只负责下载,不重新拼装审计内容。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import type { AgentRunStatus, AgentRunSummary } from "~/types";
import api from "~/services/api";
import { getWebAuthToken } from "~/services/api";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

const STATUSES: AgentRunStatus[] = [
  "running",
  "suspended",
  "succeeded",
  "failed",
  "exhausted",
  "stalled",
  "stopped",
];

export interface AgentRunAuditPage {
  runs: AgentRunSummary[];
  nextBeforeStartedAt: number | null;
  nextBeforeId: string | null;
}

/** 审计查询串(纯函数):空筛选不进查询;游标只在翻页时带。 */
export function buildAuditQuery(filters: {
  status?: string;
  engine?: string;
  conversationId?: string;
  scheduleId?: string;
  beforeStartedAt?: number | null;
  beforeId?: string | null;
  limit?: number;
}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.engine?.trim()) params.set("engine", filters.engine.trim());
  if (filters.conversationId?.trim()) params.set("conversationId", filters.conversationId.trim());
  if (filters.scheduleId?.trim()) params.set("scheduleId", filters.scheduleId.trim());
  if (filters.beforeStartedAt) params.set("beforeStartedAt", String(filters.beforeStartedAt));
  if (filters.beforeId) params.set("beforeId", filters.beforeId);
  if (filters.limit) params.set("limit", String(filters.limit));
  return params.toString();
}

/** 时间跨度(纯函数):结束有值给区间,运行中给开始时间。 */
export function formatRunSpan(run: AgentRunSummary, locale: string): string {
  const format = (at: number) => new Date(at).toLocaleString(locale);
  if (run.endedAt === null) return `${format(run.startedAt)} →`;
  return `${format(run.startedAt)} → ${format(run.endedAt)}`;
}

/** 文件名只含短 id 与日期(与服务端一致,不含目标原文)。 */
export function auditExportFilename(conversationId: string, runId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `conv-${conversationId.slice(0, 8)}-run-${runId.slice(0, 8)}-${date}.ndjson`;
}

async function downloadRunExport(conversationId: string, runId: string): Promise<void> {
  const token = getWebAuthToken();
  const response = await fetch(`/api/conversations/${conversationId}/agent-runs/${runId}/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = auditExportFilename(conversationId, runId);
    anchor.click();
  } finally {
    // 迟一拍释放:部分浏览器在 click 同步返回时就要求对象 URL 仍有效。
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export function AgentBotAuditSection() {
  const { t, i18n } = useTranslation(["settings", "page"]);
  const navigate = useNavigate();
  const [runs, setRuns] = React.useState<AgentRunSummary[]>([]);
  const [cursor, setCursor] = React.useState<{ startedAt: number | null; id: string | null }>({
    startedAt: null,
    id: null,
  });
  const [status, setStatus] = React.useState("");
  const [engine, setEngine] = React.useState("");
  const [conversationId, setConversationId] = React.useState("");
  const [scheduleId, setScheduleId] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [exporting, setExporting] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (append: boolean) => {
      setLoading(true);
      try {
        const query = buildAuditQuery({
          status,
          engine,
          conversationId,
          scheduleId,
          beforeStartedAt: append ? cursor.startedAt : null,
          beforeId: append ? cursor.id : null,
          limit: 50,
        });
        const page = await api.get<AgentRunAuditPage>(`agent-runs${query ? `?${query}` : ""}`);
        setRuns((prev) => (append ? [...prev, ...page.runs] : page.runs));
        setCursor({ startedAt: page.nextBeforeStartedAt, id: page.nextBeforeId });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [status, engine, conversationId, scheduleId, cursor.startedAt, cursor.id],
  );

  React.useEffect(() => {
    void load(false);
    // 只在筛选变化时重查;翻页由按钮显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, engine, conversationId, scheduleId]);

  const exportRun = async (run: AgentRunSummary) => {
    setExporting(run.id);
    try {
      await downloadRunExport(run.conversationId, run.id);
    } catch (error) {
      toast.error(
        t("settings:experiments.agent_bot.audit_export_failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ds-text-tertiary)]">
        {t("settings:experiments.agent_bot.audit_retention")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="h-7 rounded border border-[var(--ds-divider)] bg-transparent px-1 text-[11px]"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label={t("settings:experiments.agent_bot.audit_status")}
        >
          <option value="">{t("settings:experiments.agent_bot.audit_all_statuses")}</option>
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {t(`page:conversations.agent_run.status.${item}`, { defaultValue: item })}
            </option>
          ))}
        </select>
        <Input
          className="h-7 w-24 text-xs"
          value={engine}
          placeholder={t("settings:experiments.agent_bot.audit_engine")}
          onChange={(event) => setEngine(event.target.value)}
        />
        <Input
          className="h-7 w-44 text-xs"
          value={conversationId}
          placeholder={t("settings:experiments.agent_bot.audit_conversation")}
          onChange={(event) => setConversationId(event.target.value)}
        />
        <Input
          className="h-7 w-40 text-xs"
          value={scheduleId}
          placeholder={t("settings:experiments.agent_bot.audit_schedule")}
          onChange={(event) => setScheduleId(event.target.value)}
        />
        <Button type="button" size="xs" variant="ghost" disabled={loading} onClick={() => void load(false)}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("settings:experiments.agent_bot.audit_refresh")}
        </Button>
      </div>
      {runs.length === 0 ? (
        <p className="text-xs text-[var(--ds-text-tertiary)]">
          {loading
            ? t("settings:experiments.agent_bot.audit_loading")
            : t("settings:experiments.agent_bot.audit_empty")}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--ds-divider)] rounded border border-[var(--ds-divider)]">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
              <span className="shrink-0 font-medium text-[var(--ds-text-primary)]">
                {t(`page:conversations.agent_run.status.${run.status}`, { defaultValue: run.status })}
              </span>
              <span className="shrink-0 text-[var(--ds-text-tertiary)]">{run.engine}</span>
              <span className="min-w-0 flex-1 truncate" title={run.goal ?? undefined}>
                {run.goal || t("settings:experiments.agent_bot.audit_no_goal")}
              </span>
              {run.resumedFromRunId ? (
                <span className="shrink-0 rounded border border-[var(--ds-divider)] px-1 text-[10px] text-[var(--ds-text-tertiary)]">
                  {t("settings:experiments.agent_bot.audit_resumed")}
                </span>
              ) : null}
              {run.scheduleId ? (
                <span className="shrink-0 rounded border border-[var(--ds-divider)] px-1 text-[10px] text-[var(--ds-text-tertiary)]">
                  {t("settings:experiments.agent_bot.audit_scheduled")}
                </span>
              ) : null}
              <span className="shrink-0 tabular-nums text-[var(--ds-text-tertiary)]">
                {formatRunSpan(run, i18n.language)}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => navigate(`/c/${run.conversationId}`)}
              >
                {t("settings:experiments.agent_bot.audit_open")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={exporting === run.id}
                onClick={() => void exportRun(run)}
              >
                {exporting === run.id ? <Loader2 className="animate-spin" /> : <Download />}
                {t("settings:experiments.agent_bot.audit_export")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {cursor.startedAt !== null ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={loading}
          className={cn("w-full", loading && "opacity-60")}
          onClick={() => void load(true)}
        >
          {t("settings:experiments.agent_bot.audit_load_more")}
        </Button>
      ) : null}
    </div>
  );
}
