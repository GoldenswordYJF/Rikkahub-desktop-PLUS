// 会话计划的读取侧:把「消息流里最后一条 update_plan」还原成面板要吃的 Plan。
//
// 刻意不建会话级 plan 状态机:计划本来就是模型写进 tool part input 的 JSON,消息流就是
// 它的存储。刷新、换设备、翻历史都免费得到同一份结果,也不需要后端多一张表。
//
// 数据源用会话 store 里的 DTO 快照(entries[id].detail.messages = 节点数组),面板因此
// 跟着 SSE 的 node_update 自然刷新;流式途中 input 是半截 JSON,解析失败就当没有,
// 继续往更早的完整计划找——不闪、不吞已完成的计划。
//
// O3:单个 tool part → Plan 的解析规则搬到 @server/tools/plan 的 planFromToolPart,
// 与历史 run 投影共用一份;这里只负责「在哪找」和「选哪一条」。
import {
  normalizePlan,
  PLAN_TOOL_NAME,
  planFromToolPart,
  type Plan,
} from "@server/tools/plan";
import type {
  ConversationDto,
  RunPlanProjectionDto,
  RunPlanToolLocationDto,
  RunProjectionDto,
} from "~/types";

/** 一份计划 + 它在消息流里的来源(定位/来源角标用)。 */
export interface PlanEntry {
  plan: Plan;
  toolCallId: string | null;
  nodeId: string;
  messageId: string;
}

function planEntryFromPart(
  part: Record<string, unknown>,
  nodeId: string,
  messageId: string,
): PlanEntry | null {
  if (part.type !== "tool" || part.toolName !== PLAN_TOOL_NAME) return null;
  const plan = planFromToolPart(part);
  if (!plan || plan.steps.length === 0) return null;
  return {
    plan,
    toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : null,
    nodeId,
    messageId,
  };
}

/** 取本会话最新一份非空计划及其来源;没有则 null。倒序扫(新→旧),找到即停。 */
export function getLatestPlanEntry(detail: ConversationDto | null | undefined): PlanEntry | null {
  const nodes = detail?.messages;
  if (!Array.isArray(nodes)) return null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i] as { id?: string; messages?: unknown[]; selectIndex?: number } | undefined;
    const candidates = Array.isArray(node?.messages) ? node!.messages : [];
    const index = typeof node?.selectIndex === "number" ? node.selectIndex : 0;
    const message = (candidates[index] ?? candidates[0]) as { id?: string; parts?: unknown } | undefined;
    const parts = Array.isArray(message?.parts) ? (message!.parts as Record<string, unknown>[]) : [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!part || typeof part !== "object") continue;
      const entry = planEntryFromPart(
        part,
        typeof node?.id === "string" ? node.id : "",
        typeof message?.id === "string" ? message.id : "",
      );
      if (entry) return entry;
    }
  }
  return null;
}

/** 兼容旧调用方:只要 Plan。 */
export function getLatestPlan(detail: ConversationDto | null | undefined): Plan | null {
  return getLatestPlanEntry(detail)?.plan ?? null;
}

/** run 级投影 → 面板视图。null 投影(尚未加载/失败)返回 null,调用方保留加载态;
 *  投影存在但不可用时返回 plan:null + unavailableReason,不伪造计划。 */
export interface RunPlanView {
  plan: Plan | null;
  v2: boolean;
  sourceToolCallId: string | null;
  sourceMessageId: string | null;
  unavailableReason: RunPlanProjectionDto["unavailableReason"];
  toolLocations: Record<string, RunPlanToolLocationDto>;
}

export function planViewFromProjection(projection: RunProjectionDto | null): RunPlanView | null {
  if (!projection) return null;
  const payload = projection.plan;
  const plan = payload.plan ? normalizePlan(payload.plan, { trusted: true }) : null;
  return {
    plan: plan && plan.steps.length > 0 ? plan : null,
    v2: payload.v2 === true,
    sourceToolCallId: payload.sourceToolCallId,
    sourceMessageId: payload.sourceMessageId,
    unavailableReason: payload.unavailableReason,
    toolLocations: payload.toolLocations ?? {},
  };
}
