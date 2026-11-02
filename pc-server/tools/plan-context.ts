// tools/plan-context.ts — update_plan 改写保护的前值读取(自主循环 S2)。
//
// 纪律:只读会话消息流,零状态、零落库。计划本身仍活在 tool part 里(§4.1),
// 这里只回答两个问题:
//   1) 本轮(最后一条用户消息之后)是否已经发布过计划?是 → 把它作为合并基线;
//   2) 上一版计划是否属于「同一 run」?只有新用户消息才能改写 goal/done_when/boundaries
//      (以及重置 attempts 等计数),所以跨用户消息的计划不参与合并。
//
// 权威性:上一版计划优先取工具结果里的服务端快照(metadata.planV2,已做改写保护),
// 回退才解析原始 input。否则模型第一次篡改的 goal 会变成下一次合并的基线,保护形同虚设。
//
// 失败方向:任何畸形节点/半截 JSON 都跳过,不抛错——计划工具不能因为历史脏数据变砖。

import type { Conversation } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { normalizePlan, PLAN_TOOL_NAME, type Plan } from "./plan";

export interface PlanContext {
  /** 同一 run 内的上一版计划;null = 本轮首次发布(或上一条用户消息已开启新 run)。 */
  previous: Plan | null;
  /** true = 允许重设目标三件套(首次发布 / 新用户消息之后)。 */
  allowGoalChange: boolean;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从一条 update_plan tool part 还原计划:优先权威快照,回退原始 input。 */
function planFromToolPart(part: Record<string, unknown>): Plan | null {
  const output = Array.isArray(part.output) ? part.output : [];
  for (let i = output.length - 1; i >= 0; i--) {
    const entry = output[i];
    if (!isRecord(entry) || entry.type !== "text" || !isRecord(entry.metadata)) continue;
    if (!isRecord(entry.metadata.planV2)) continue;
    const plan = normalizePlan(entry.metadata.planV2, { trusted: true });
    if (plan.steps.length > 0) return plan;
  }
  const input = typeof part.input === "string" ? safeParse(part.input) : part.input;
  const plan = normalizePlan(input);
  return plan.steps.length > 0 ? plan : null;
}

/** 按消息流顺序找上一版计划,并判定它是否属于当前 run。 */
export function findPlanContext(conversation: Conversation, currentToolCallId?: string): PlanContext {
  let seq = 0;
  let lastUserSeq = -1;
  let candidate: { plan: Plan; seq: number } | null = null;
  const nodes = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const node of nodes) {
    const index = typeof node?.selectIndex === "number" ? node.selectIndex : 0;
    const message = node?.messages?.[index] ?? node?.messages?.[0];
    if (!message) continue;
    seq += 1;
    if (message.role === "USER") lastUserSeq = seq;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool" || part.toolName !== PLAN_TOOL_NAME) continue;
      if (currentToolCallId && String(part.toolCallId ?? "") === currentToolCallId) continue;
      const plan = planFromToolPart(part);
      if (plan) candidate = { plan, seq };
    }
  }
  if (!candidate) return { previous: null, allowGoalChange: true };
  const sameRun = candidate.seq > lastUserSeq;
  return { previous: sameRun ? candidate.plan : null, allowGoalChange: !sameRun };
}

/** steering 注入落库的用户消息(steerBoundary 加的注解):是同一生成内的补发,
 *  不开启新 run,计划继续有效。 */
function isSteeredMessage(message: { annotations?: unknown }): boolean {
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  return annotations.some((entry) => isRecord(entry) && entry.type === "steered");
}

/** 会话选中路径上「当前 run」的最新完整计划(完成校验与运行记录读它)。
 *  run 边界 = 最后一条非 steered 的 USER 消息:
 *   - steer 补发插入的 USER 消息带 steered 注解,不算新 run——计划仍是当前有效的那份;
 *   - 用户重新发言(含点"继续"/"改目标")则开启新 run,旧计划不再参与本轮完成校验,
 *     等模型重新发布。否则上一轮搁置的计划会把一个全新的话题误判为"未了结"。 */
export function latestPlan(conversation: Conversation | null | undefined): Plan | null {
  if (!conversation) return null;
  let seq = 0;
  let lastUserSeq = 0;
  let candidate: { plan: Plan; seq: number } | null = null;
  const nodes = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const node of nodes) {
    const index = typeof node?.selectIndex === "number" ? node.selectIndex : 0;
    const message = node?.messages?.[index] ?? node?.messages?.[0];
    if (!message) continue;
    seq += 1;
    if (message.role === "USER" && !isSteeredMessage(message)) lastUserSeq = seq;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool" || part.toolName !== PLAN_TOOL_NAME) continue;
      const plan = planFromToolPart(part);
      if (plan) candidate = { plan, seq };
    }
  }
  if (!candidate) return null;
  return candidate.seq > lastUserSeq ? candidate.plan : null;
}
