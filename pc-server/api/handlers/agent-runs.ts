// api/handlers/agent-runs.ts — 生命周期 L4:跨会话只读审计查询
//
// 只返回摘要,不返回正文;非法状态/游标 400,不静默退化成全量查询;
// 不提供 DELETE / 清审计接口(审计边界见 docs/plan-task-lifecycle.md §5.3)。

import { listAgentRunsForAudit } from "../../agent-loop/run-store";
import type { AgentRunStatus } from "../../agent-loop/types";
import { error, json } from "../request";

const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  "running",
  "suspended",
  "succeeded",
  "failed",
  "exhausted",
  "stalled",
  "stopped",
];

export async function handleAgentRunRoutes(
  request: Request,
  url: URL,
  path: string,
): Promise<Response | null> {
  if (path !== "agent-runs") return null;
  if (request.method !== "GET") return null;

  const statusRaw = url.searchParams.get("status");
  let status: AgentRunStatus | undefined;
  if (statusRaw !== null) {
    if (!(AGENT_RUN_STATUSES as readonly string[]).includes(statusRaw)) {
      return error(`Invalid status: ${statusRaw}`, 400);
    }
    status = statusRaw as AgentRunStatus;
  }

  const beforeRaw = url.searchParams.get("beforeStartedAt");
  let beforeStartedAt: number | undefined;
  if (beforeRaw !== null) {
    const parsed = Number(beforeRaw);
    if (!Number.isInteger(parsed) || parsed < 1) return error("Invalid beforeStartedAt", 400);
    beforeStartedAt = parsed;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed)) return error("Invalid limit", 400);
    limit = Math.min(100, Math.max(1, Math.floor(parsed)));
  }

  const conversationId = url.searchParams.get("conversationId") || undefined;
  const engine = url.searchParams.get("engine") || undefined;
  const scheduleId = url.searchParams.get("scheduleId") || undefined;
  const beforeId = url.searchParams.get("beforeId") || undefined;

  return json(
    listAgentRunsForAudit({
      conversationId,
      status,
      engine,
      scheduleId,
      beforeStartedAt,
      beforeId,
      limit,
    }),
  );
}
