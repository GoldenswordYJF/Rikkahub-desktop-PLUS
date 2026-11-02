// agent-loop/plan-projection.ts — run 级计划投影(O3)
//
// 纪律:
//  - 只读:不改会话、不写 run 事件;投影失败只表现为 unavailableReason。
//  - 解析只走 tools/plan 的 planFromToolPart(与最新计划面板同源),这里不另写一套规则。
//  - 来源优先「该 run 最后一次 update_plan 事件的 toolCallId → 精确消息查询」;跨分支
//    精确 id 仍可还原(定位入口会标 visible=false),但绝不在非选中分支做兜底猜测。
//  - 没有计划变更时才从 run.nodeId 沿选中分支向前找最近权威快照,遇到最近的前置
//    非 steering USER 任务边界立即停止——新任务不会捡上一任务的计划。
//  - 来源/锚点/边界无法唯一确定时返回明确原因,不回退到别的 run。
//
// 事件可能在尚未加载的旧页:这里直接查 run 全部事件,不经过前端分页窗口。

import type { Conversation, Message } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { isPlanV2, PLAN_TOOL_NAME, planFromToolPart, toPlanSnapshot, type Plan } from "../tools/plan";
import { boundarySnapshotsForRun, lastToolCallEventForRun } from "./run-store";
import type {
  AgentRunSummary,
  RunPlanProjectionDto,
  RunPlanToolLocationDto,
  RunProjectionDto,
} from "./types";

interface ToolPartOccurrence {
  toolCallId: string;
  toolName: string;
  part: Record<string, unknown>;
  nodeIndex: number;
  messageId: string;
  visible: boolean;
}

interface ConversationToolIndex {
  /** toolCallId → 全部出现位置(分叉复制可能产生多条)。 */
  byToolCallId: Map<string, ToolPartOccurrence[]>;
  /** run.nodeId 对应的节点下标;找不到为 -1。 */
  anchorIndex: number;
  anchorFound: boolean;
}

interface FoundPlan {
  plan: Plan;
  occurrence: ToolPartOccurrence;
}

function selectedMessage(node: Conversation["messages"][number]): Message | undefined {
  return node.messages[node.selectIndex] ?? node.messages[0];
}

/** 只认当前选中分支上的消息参与兜底扫描;精确 id 查询另行跨分支。 */
function indexConversation(conversation: Conversation, run: AgentRunSummary): ConversationToolIndex {
  const byToolCallId = new Map<string, ToolPartOccurrence[]>();
  for (const [nodeIndex, node] of conversation.messages.entries()) {
    const selectedIndex = node.selectIndex ?? 0;
    for (const [messageIndex, message] of node.messages.entries()) {
      for (const part of message.parts) {
        if (!isRecord(part) || part.type !== "tool") continue;
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
        if (!toolCallId) continue;
        const occurrence: ToolPartOccurrence = {
          toolCallId,
          toolName: typeof part.toolName === "string" ? part.toolName : "",
          part,
          nodeIndex,
          messageId: message.id,
          visible: messageIndex === selectedIndex,
        };
        const bucket = byToolCallId.get(toolCallId);
        if (bucket) bucket.push(occurrence);
        else byToolCallId.set(toolCallId, [occurrence]);
      }
    }
  }
  const anchorIndex = run.nodeId
    ? conversation.messages.findIndex((node) => node.id === run.nodeId)
    : -1;
  return { byToolCallId, anchorIndex, anchorFound: anchorIndex >= 0 };
}

function planOccurrences(index: ConversationToolIndex, toolCallId: string): FoundPlan[] {
  const occurrences = index.byToolCallId.get(toolCallId) ?? [];
  const found: FoundPlan[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.toolName !== PLAN_TOOL_NAME) continue;
    const plan = planFromToolPart(occurrence.part);
    if (!plan) continue;
    found.push({ plan, occurrence });
  }
  return found;
}

/** steering 注入的用户消息属于同一任务;其余 USER 消息开启新任务,是兜底扫描的硬边界。 */
function isTaskBoundary(message: Message): boolean {
  if (message.role !== "USER") return false;
  return !message.annotations.some((annotation) => isRecord(annotation) && annotation.type === "steered");
}

/** 没有该 run 的计划事件时,沿选中分支从 run 节点向前找最近权威快照。 */
function findFallbackPlan(
  conversation: Conversation,
  index: ConversationToolIndex,
): { plan: FoundPlan | null; unavailableReason: RunPlanProjectionDto["unavailableReason"] } {
  if (!index.anchorFound) return { plan: null, unavailableReason: "anchor_missing" };
  for (let nodeIndex = index.anchorIndex; nodeIndex >= 0; nodeIndex--) {
    const node = conversation.messages[nodeIndex]!;
    const message = selectedMessage(node);
    if (!message) continue;
    if (nodeIndex < index.anchorIndex && isTaskBoundary(message)) break;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex];
      if (!isRecord(part) || part.type !== "tool" || part.toolName !== PLAN_TOOL_NAME) continue;
      const plan = planFromToolPart(part);
      if (!plan) continue;
      const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
      return {
        plan: {
          plan,
          occurrence: {
            toolCallId,
            toolName: PLAN_TOOL_NAME,
            part,
            nodeIndex,
            messageId: message.id,
            visible: true,
          },
        },
        unavailableReason: null,
      };
    }
  }
  return { plan: null, unavailableReason: "no_plan" };
}

function locationFor(index: ConversationToolIndex, toolCallId: string): RunPlanToolLocationDto | null {
  const occurrences = index.byToolCallId.get(toolCallId);
  if (!occurrences || occurrences.length === 0) return null;
  const visible = occurrences.find((occurrence) => occurrence.visible) ?? occurrences[0]!;
  return { messageId: visible.messageId, visible: visible.visible };
}

function collectEvidenceIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    for (const id of step.evidence ?? []) ids.add(id);
  }
  return [...ids];
}

function resolveProjection(
  conversation: Conversation,
  run: AgentRunSummary,
  found: FoundPlan | null,
  unavailableReason: RunPlanProjectionDto["unavailableReason"],
  sourceToolCallId: string | null,
  index: ConversationToolIndex,
): RunProjectionDto {
  // O4:边界定义与该 run 的事件页加载进度无关,一律从全量 boundary 事件构建。
  const boundaries = boundarySnapshotsForRun(run.id);
  if (!found) {
    return {
      runId: run.id,
      plan: {
        plan: null,
        sourceToolCallId,
        sourceMessageId: null,
        unavailableReason,
        v2: false,
        toolLocations: {},
      },
      boundaries,
    };
  }
  const toolLocations: Record<string, RunPlanToolLocationDto> = {};
  const evidenceIds = collectEvidenceIds(found.plan);
  for (const toolCallId of [found.occurrence.toolCallId, ...evidenceIds]) {
    if (!toolCallId || toolLocations[toolCallId]) continue;
    const location = locationFor(index, toolCallId);
    if (location) toolLocations[toolCallId] = location;
  }
  return {
    runId: run.id,
    plan: {
      plan: toPlanSnapshot(found.plan),
      sourceToolCallId: found.occurrence.toolCallId || null,
      sourceMessageId: found.occurrence.messageId,
      unavailableReason: null,
      v2: isPlanV2(found.plan),
      toolLocations,
    },
    boundaries,
  };
}

/** 计算一次 run 的计划投影。纯读取;调用方已完成 run 归属校验。 */
export function getRunPlanProjection(conversation: Conversation, run: AgentRunSummary): RunProjectionDto {
  const index = indexConversation(conversation, run);
  const lastPlanEvent = lastToolCallEventForRun(run.id, PLAN_TOOL_NAME);
  if (lastPlanEvent) {
    const payload = lastPlanEvent.payload;
    const toolCallId =
      payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.toolCallId === "string"
        ? payload.toolCallId
        : "";
    if (!toolCallId) {
      return resolveProjection(conversation, run, null, "source_missing", null, index);
    }
    const found = planOccurrences(index, toolCallId);
    const uniqueMessages = new Set(found.map((item) => item.occurrence.messageId));
    if (found.length === 0) {
      // 事件存在但工具卡已找不到:不回退到更早计划,如实报证据丢失。
      const occurrences = index.byToolCallId.get(toolCallId) ?? [];
      const planTool = occurrences.find((occurrence) => occurrence.toolName === PLAN_TOOL_NAME);
      return resolveProjection(
        conversation,
        run,
        null,
        planTool ? "invalid_plan" : "source_missing",
        toolCallId,
        index,
      );
    }
    if (uniqueMessages.size > 1) {
      return resolveProjection(conversation, run, null, "source_ambiguous", toolCallId, index);
    }
    const preferred = found.find((item) => item.occurrence.visible) ?? found[0]!;
    return resolveProjection(conversation, run, preferred, null, toolCallId, index);
  }

  const fallback = findFallbackPlan(conversation, index);
  return resolveProjection(
    conversation,
    run,
    fallback.plan,
    fallback.unavailableReason,
    fallback.plan?.occurrence.toolCallId || null,
    index,
  );
}
