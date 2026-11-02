// tools/discovery-store.test.ts — S9 运行时粘合层回归(全局 state 装配口)
// 覆盖:开关关闭 = 与 conversationFunctionTools 逐字一致;开启后 MCP 声明不进初始
// 数组、search_tools 就位;目录段只在开启且有池时出现;执行守卫(关闭/无会话)。
// 激活集持久化的读写语义在 conversations/tool-activation.test.ts 独立覆盖;
// S11 诊断(激活/待激活/失效原因)在本文件用显式激活集单测。
import { afterAll, describe, expect, test } from "bun:test";
import type { Assistant, State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { conversationFunctionTools } from "./bound";
import {
  buildToolDiscoveryDiagnostics,
  conversationToolsWithDiscovery,
  runSearchToolsTool,
  toolDiscoverySystemContext,
} from "./discovery-store";

const priorState = state;

function installFixture(): void {
  setState({
    settings: {
      enableWebSearch: false,
      mcpServers: [
        {
          id: "srv",
          type: "http",
          commonOptions: {
            name: "GitHub",
            enable: true,
            tools: [
              { name: "create_issue", description: "Create a GitHub issue", inputSchema: { type: "object", properties: {} } },
              { name: "list_prs", description: "List pull requests", inputSchema: { type: "object", properties: {} } },
            ],
          },
        },
      ],
      memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
      subagent: { enabled: false },
      workspaceTools: {},
    },
  } as unknown as State);
}

function assistantFixture(): Assistant {
  return {
    id: "a1",
    mcpServers: ["srv"],
    mcpToolOverrides: {},
    localTools: [],
    enabledSkills: [],
    enableMemory: false,
    memoryWriteScope: "readonly",
    enableToolDiscovery: true,
  } as unknown as Assistant;
}

afterAll(() => setState(priorState));

describe("conversationToolsWithDiscovery", () => {
  test("开关关闭:与 conversationFunctionTools 深相等(行为与引入前一致)", () => {
    installFixture();
    const assistant = { ...assistantFixture(), enableToolDiscovery: false };
    const actual = conversationToolsWithDiscovery(assistant, null, "discovery-store-c1");
    const expected = conversationFunctionTools(assistant, null);
    expect(actual).toEqual(expected);
    expect(actual.map((tool) => tool.function.name)).toContain("mcp__create_issue");
  });

  test("开关开启:初始数组不带未激活 MCP schema,search_tools 就位", () => {
    installFixture();
    const names = conversationToolsWithDiscovery(assistantFixture(), null, "discovery-store-c1").map((tool) => tool.function.name);
    expect(names).toContain("search_tools");
    expect(names).not.toContain("mcp__create_issue");
    expect(names).not.toContain("mcp__list_prs");
  });

  test("无会话 id / 无 MCP 池:退回原数组", () => {
    installFixture();
    const assistant = assistantFixture();
    expect(conversationToolsWithDiscovery(assistant, null, null))
      .toEqual(conversationFunctionTools(assistant, null));
    // 助手未选任何 MCP 服务器 → 池为空 → 不插入 search_tools
    const noMcp = { ...assistant, mcpServers: [] };
    expect(conversationToolsWithDiscovery(noMcp, null, "discovery-store-c1"))
      .toEqual(conversationFunctionTools(noMcp, null));
  });
});

describe("toolDiscoverySystemContext", () => {
  test("开关关闭/无会话 → 空串;开启 → 含激活与隐藏目录", () => {
    installFixture();
    expect(toolDiscoverySystemContext({ ...assistantFixture(), enableToolDiscovery: false }, "discovery-store-c1")).toBe("");
    expect(toolDiscoverySystemContext(assistantFixture(), null)).toBe("");
    const context = toolDiscoverySystemContext(assistantFixture(), "discovery-store-c1");
    expect(context).toContain("**Tool catalog**");
    expect(context).toContain("No MCP tools are loaded yet.");
    expect(context).toContain("Hidden MCP tools (2): mcp__create_issue, mcp__list_prs");
  });
});

describe("runSearchToolsTool 守卫", () => {
  test("开关关闭 → 明确拒绝;无会话 → 报错", () => {
    installFixture();
    expect(() => runSearchToolsTool({ ...assistantFixture(), enableToolDiscovery: false }, { query: "issue" }, { conversationId: "discovery-store-c1" }))
      .toThrow(/Tool discovery is disabled/);
    expect(() => runSearchToolsTool(assistantFixture(), { query: "issue" }, {}))
      .toThrow(/requires an active conversation/);
  });

  test("开启且有会话 → 返回命中文本(库未开时登记为 no-op)", () => {
    installFixture();
    const text = runSearchToolsTool(assistantFixture(), { query: "issue" }, { conversationId: "discovery-store-c1" });
    expect(text).toContain("mcp__create_issue");
    expect(text).toContain("next round");
  });
});

describe("S11 诊断", () => {
  function installDiagnosticsFixture(): void {
    setState({
      settings: {
        enableWebSearch: false,
        mcpServers: [
          {
            id: "srv",
            type: "http",
            commonOptions: {
              name: "GitHub",
              enable: true,
              tools: [
                { name: "create_issue", description: "Create", inputSchema: { type: "object", properties: {} } },
                { name: "list_prs", description: "List PRs", inputSchema: { type: "object", properties: {} } },
                { name: "off_tool", description: "Off", enable: false, inputSchema: { type: "object", properties: {} } },
              ],
            },
          },
          {
            id: "off-server",
            type: "http",
            commonOptions: {
              name: "OffSrv",
              enable: false,
              tools: [{ name: "sleep_tool", description: "Sleep", inputSchema: { type: "object", properties: {} } }],
            },
          },
          {
            id: "detached",
            type: "http",
            commonOptions: {
              name: "Detached",
              enable: true,
              tools: [{ name: "detached_tool", description: "Det", inputSchema: { type: "object", properties: {} } }],
            },
          },
        ],
        memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
        subagent: { enabled: false },
        workspaceTools: {},
      },
    } as unknown as State);
  }

  function diagnosticsAssistant(): Assistant {
    return {
      ...assistantFixture(),
      mcpServers: ["srv", "off-server"],
      mcpToolOverrides: { srv: { create_issue: { enable: false } } },
    } as unknown as Assistant;
  }

  test("失效原因分类:覆盖关闭/工具关闭/服务器禁用/未挂载/配置中消失", () => {
    installDiagnosticsFixture();
    const diagnostics = buildToolDiscoveryDiagnostics(diagnosticsAssistant(), "discovery-store-c1", {
      active: ["mcp__create_issue", "mcp__off_tool", "mcp__sleep_tool", "mcp__list_prs"],
      pending: ["mcp__detached_tool", "mcp__deleted_tool"],
    });
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.conversationId).toBe("discovery-store-c1");
    expect(diagnostics.poolSize).toBe(1); // 只有 list_prs 当前可见
    expect(diagnostics.active).toHaveLength(4);
    expect(diagnostics.pending).toHaveLength(2);
    const reasons = Object.fromEntries(diagnostics.invalid.map((entry) => [entry.name, entry.reason]));
    expect(reasons).toEqual({
      mcp__create_issue: "override_disabled",
      mcp__off_tool: "tool_disabled",
      mcp__sleep_tool: "server_disabled",
      mcp__detached_tool: "server_not_attached",
      mcp__deleted_tool: "server_missing",
    });
    const sections = Object.fromEntries(diagnostics.invalid.map((entry) => [entry.name, entry.section]));
    expect(sections.mcp__detached_tool).toBe("pending");
    expect(sections.mcp__create_issue).toBe("active");
    // 存活项不进失效清单
    expect(diagnostics.invalid.some((entry) => entry.name === "mcp__list_prs")).toBe(false);
  });

  test("开关关闭 → enabled=false、池为空,激活集休眠不判失效", () => {
    installDiagnosticsFixture();
    const diagnostics = buildToolDiscoveryDiagnostics(
      { ...diagnosticsAssistant(), enableToolDiscovery: false } as unknown as Assistant,
      "discovery-store-c1",
      { active: ["mcp__list_prs"], pending: [] },
    );
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.poolSize).toBe(0);
    expect(diagnostics.active).toEqual(["mcp__list_prs"]);
    expect(diagnostics.invalid).toEqual([]);
  });
});
