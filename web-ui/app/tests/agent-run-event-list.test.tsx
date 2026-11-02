// O2 事件流水视图契约:短 toolCallId + 定位入口、加载更早、加载/错误/空态。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentRunEventList } from "~/components/workspace/agent-run-panel";
import { shortToolCallId } from "~/lib/agent-run-locate";
import i18n from "~/i18n";
import type { AgentRunEventDto } from "~/types";

function event(seq: number, kind: string, payload: AgentRunEventDto["payload"] = null): AgentRunEventDto {
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    kind: kind as AgentRunEventDto["kind"],
    summary: `事件 ${seq}`,
    payload,
  };
}

describe("事件流水视图", () => {
  test("工具事件展示短 toolCallId、完整 id 与定位按钮", () => {
    const full = "call_0123456789abcdef";
    const html = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [event(1, "tool_call", { toolCallId: full, toolName: "bash" })],
        onLocateToolCall: () => {},
      }),
    );
    expect(html).toContain(shortToolCallId(full));
    expect(html).toContain(full);
    expect(html).toContain(i18n.t("conversations.agent_run.locate", { ns: "page" }));
  });

  test("审批事件同样可定位;无 toolCallId 的事件不伪造入口", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [event(1, "approval", { toolCallId: "tc-1", decision: "approved" })],
        onLocateToolCall: () => {},
      }),
    );
    expect(html).toContain("tc-1");
    expect(html).toContain(i18n.t("conversations.agent_run.locate", { ns: "page" }));

    const plain = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [event(1, "round", { round: 1 })],
        onLocateToolCall: () => {},
      }),
    );
    expect(plain).not.toContain(i18n.t("conversations.agent_run.locate", { ns: "page" }));
  });

  test("有更早页时显示“加载更早”,加载中显示加载态", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [event(2)],
        hasMore: true,
        onLoadOlder: () => {},
        loadingOlder: true,
      }),
    );
    expect(html).toContain(i18n.t("conversations.agent_run.loading_older", { ns: "page" }));

    const idle = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [event(2)],
        hasMore: true,
        onLoadOlder: () => {},
      }),
    );
    expect(idle).toContain(i18n.t("conversations.agent_run.load_older", { ns: "page" }));
  });

  test("历史加载失败与空窗口各自给出明确文案", () => {
    const failed = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [],
        error: i18n.t("conversations.agent_run.history_failed", { ns: "page" }),
      }),
    );
    expect(failed).toContain(i18n.t("conversations.agent_run.history_failed", { ns: "page" }));

    const empty = renderToStaticMarkup(
      React.createElement(AgentRunEventList, { events: [] }),
    );
    expect(empty).toContain(i18n.t("conversations.agent_run.empty", { ns: "page" }));
  });

  test("短 id 规则:短 id 原样,长 id 截断并保留省略号", () => {
    expect(shortToolCallId("tc-1")).toBe("tc-1");
    expect(shortToolCallId("call_0123456789abcdef")).toBe("call_012…");
  });

  test("O4:引用事件从投影解析边界;full_access 与系统沙箱同时展示", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [
          event(2, "tool_execution", {
            toolCallId: "tc-write",
            toolName: "write",
            boundaryId: "b1234567890a",
            access: "write",
            targetScope: "inside",
          }),
        ],
        boundaries: {
          b1234567890a: {
            workspace: { id: "ws-1", type: "local", root: "/work", cwd: "/work" },
            permissionPreset: "full_access",
            effectiveWriteScope: "wide",
            sandbox: {
              tier: "restricted",
              measured: "enforced",
              boundaryActive: true,
              mechanism: "windows_integrity",
              checkedAt: 1,
            },
          },
        },
      }),
    );
    expect(html).toContain("完全访问");
    expect(html).toContain("可写工作区外");
    // 系统沙箱必须独立显示:full_access 只描述应用权限档。
    expect(html).toContain("系统沙箱生效");
    expect(html).toContain("写入");
    expect(html).toContain("工作区内");
    expect(html).not.toContain("边界定义不可用");
  });

  test("O4:边界定义未加载/缺失时明确提示,不把引用当成无边界", () => {
    const ref = event(2, "approval", {
      toolCallId: "tc-1",
      toolName: "write",
      decision: "pending",
      boundaryId: "b-missing",
      reasonCode: "outside_workspace_write",
    });
    const missing = renderToStaticMarkup(
      React.createElement(AgentRunEventList, { events: [ref], boundaries: {} }),
    );
    expect(missing).toContain(i18n.t("conversations.agent_run.boundary_unavailable", { ns: "page" }));
    expect(missing).toContain("工作区外写入");

    const loading = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [ref],
        boundaries: {},
        boundariesLoading: true,
      }),
    );
    expect(loading).toContain(i18n.t("conversations.agent_run.boundary_loading", { ns: "page" }));
  });

  test("O4:危险命令 pending 只展示规则 id,不拼完整命令", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentRunEventList, {
        events: [
          event(2, "approval", {
            toolCallId: "tc-1",
            toolName: "bash",
            decision: "pending",
            reasonCode: "destructive_command",
            ruleId: "rm_root",
            reasonSummary: "recursive force-delete of the filesystem root or home directory",
          }),
        ],
        boundaries: {},
        boundariesLoading: true,
      }),
    );
    expect(html).toContain("破坏性命令");
    expect(html).toContain("rm_root");
    expect(html).not.toContain("rm -rf");
  });
});

describe("运行面板 hook 顺序", () => {
  test("有 run / 无 run 的早退之后不得再出现 hook(React #310)", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "components", "workspace", "agent-run-panel.tsx"),
      "utf8",
    );
    const earlyReturn = source.indexOf("if (!entry) return null;");
    expect(earlyReturn).toBeGreaterThan(-1);
    // entry 由 SSE 异步补上;早退前少跑一个 hook 会在下一次渲染直接抛 React #310。
    const hooksAfter = source.slice(earlyReturn).match(/React\.use[A-Z]/g) ?? [];
    expect(hooksAfter).toEqual([]);
  });
});
