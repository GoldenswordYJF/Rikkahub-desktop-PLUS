// lib/agent-run-locate.ts — 运行事件 → 消息工具卡的定位辅助(O2)
//
// 事件只带 toolCallId,不复制工具详情;定位复用现有消息聚焦机制(`?msg=<messageId>`)。
// 这里只做纯查找:当前已加载分支里哪个消息持有该 toolCallId。找不到时调用方必须如实
// 显示“不可定位”,不能猜消息位置(O3 的历史证据同理)。
import type { ConversationDto } from "~/types";

/** 当前会话已加载消息中的 toolCallId → messageId(同一 id 取最早出现,理论唯一)。 */
export function buildToolCallMessageIndex(
  detail: ConversationDto | null | undefined,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of detail?.messages ?? []) {
    // 只认当前选中分支:其它分支的工具卡在时间线上不可见,不能给出假定位。
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (!message) continue;
    for (const part of message.parts ?? []) {
      if (part.type !== "tool" || !part.toolCallId) continue;
      if (!index.has(part.toolCallId)) index.set(part.toolCallId, message.id);
    }
  }
  return index;
}

/** 面板里的短 id:够定位、不撑破一行。 */
export function shortToolCallId(toolCallId: string, max = 8): string {
  return toolCallId.length > max ? `${toolCallId.slice(0, max)}…` : toolCallId;
}
