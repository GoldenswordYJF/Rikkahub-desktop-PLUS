// agent-run 未知事件兜底契约(O1)
//
// 后端允许新增 AgentRunEventKind(只增不改)。旧前端在升级窗口里必须:
//  - 未知 kind 有安全图标,不能因 EVENT_ICON[kind] 为 undefined 直接崩;
//  - 有摘要就展示摘要,没摘要也要明确标注"未识别事件",不静默丢行;
//  - 已知 kind 的本地化描述不受影响。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentRunEventList, agentRunEventIcon } from "~/components/workspace/agent-run-panel";
import type { AgentRunEventDto } from "~/types";
import i18n from "~/i18n";

function event(seq: number, kind: string, summary = "", payload: AgentRunEventDto["payload"] = null): AgentRunEventDto {
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    kind: kind as AgentRunEventDto["kind"],
    summary,
    payload,
  };
}

function renderList(events: AgentRunEventDto[]): string {
  return renderToStaticMarkup(React.createElement(AgentRunEventList, { events }));
}

describe("未知 kind 降级", () => {
  test("有摘要时原样展示,不丢行", () => {
    const html = renderList([event(1, "future_kind", "服务端未来事件")]);
    expect(html).toContain("服务端未来事件");
  });

  test("无摘要时显示未识别事件与该 kind", () => {
    const html = renderList([event(1, "future_kind")]);
    const fallback = i18n.t("conversations.agent_run.unknown_event", {
      ns: "page",
      kind: "future_kind",
    });
    expect(fallback).toContain("future_kind");
    expect(html).toContain(fallback);
  });

  test("未知 kind 拿到安全图标;已知 kind 保持原图标", () => {
    expect(agentRunEventIcon("future_kind")).toBeDefined();
    expect(agentRunEventIcon("round")).toBeDefined();
    expect(agentRunEventIcon("future_kind")).not.toBe(agentRunEventIcon("round"));
  });

  test("未知事件与已知事件混排时,已知事件仍走本地化文案", () => {
    const html = renderList([
      event(1, "future_kind", "未来事件"),
      event(2, "round", "第 2 轮", { round: 2 }),
    ]);
    expect(html).toContain("未来事件");
    expect(html).toContain("第 2 轮");
  });
});
