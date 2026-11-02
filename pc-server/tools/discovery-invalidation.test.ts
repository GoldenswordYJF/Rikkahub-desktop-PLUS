// tools/discovery-invalidation.test.ts — S11 失效闭环(演示边界)
// 真会话库 + 全局 state:服务器启用时工具随激活集进入请求面;禁用后立即消失且
// active/pending 都被清理;重新启用后 search_tools 可再次发现并激活。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assistant, State } from "../foundation/types";
import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-discovery-invalidation-"));

const jsonStore = await import("../persistence/json-store");
const { setState, state } = jsonStore;
const conversations = await import("../conversations");
const { conversationToolsWithDiscovery, runSearchToolsTool } = await import("./discovery-store");
const { assemblePiToolDiscovery } = await import("../pi-engine/tool-discovery");
const { promotePendingToolActivationIn, readToolActivationFrom, writeToolActivationInto } = await import(
  "../conversations/tool-activation"
);

const priorState = state;
const db = conversations.openConversationsDb();
db.prepare(
  "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES ('inv-c1', 'a1', '', '', '[]', 0, 1, 1)",
).run();

const assistant = {
  id: "a1",
  mcpServers: ["srv"],
  mcpToolOverrides: {},
  enableToolDiscovery: true,
} as unknown as Assistant;

function install(serverEnabled: boolean): void {
  setState({
    settings: {
      enableWebSearch: false,
      mcpServers: [
        {
          id: "srv",
          type: "http",
          commonOptions: {
            name: "GitHub",
            enable: serverEnabled,
            tools: [
              { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: {} } },
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

function toolNames(): string[] {
  return conversationToolsWithDiscovery(assistant, null, "inv-c1").map((tool) => tool.function.name);
}

function piTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    executionMode: "sequential",
    execute: async () => ({ content: [] }),
  } as unknown as ToolDefinition;
}

afterAll(() => setState(priorState));

describe("S11 服务器禁用/启用闭环", () => {
  test("禁用 → 工具离开请求面、active+pending 清理;启用 → 可再次搜索发现", () => {
    install(true);
    writeToolActivationInto(db, "inv-c1", { active: ["mcp__create_issue"], pending: ["mcp__list_prs"] });
    let names = toolNames();
    expect(names).toContain("mcp__create_issue");
    expect(names).not.toContain("mcp__list_prs"); // pending 本轮不生效

    install(false);
    names = toolNames();
    expect(names).not.toContain("mcp__create_issue");
    expect(names).not.toContain("mcp__list_prs");
    // 立即清理:重新启用不会让旧激活名自动复活,必须重新发现。
    expect(readToolActivationFrom(db, "inv-c1")).toEqual({ active: [], pending: [] });

    install(true);
    expect(readToolActivationFrom(db, "inv-c1")).toEqual({ active: [], pending: [] });
    const text = runSearchToolsTool(assistant, { query: "issue" }, { conversationId: "inv-c1" });
    expect(text).toContain("mcp__create_issue");
    expect(readToolActivationFrom(db, "inv-c1").pending).toEqual(["mcp__create_issue"]);

    expect(promotePendingToolActivationIn(db, "inv-c1")).toEqual(["mcp__create_issue"]);
    names = toolNames();
    expect(names).toContain("mcp__create_issue");
  });

  test("服务器未挂到助手:与禁用同样清理,不产生半状态", () => {
    install(true);
    writeToolActivationInto(db, "inv-c1", { active: ["mcp__create_issue"], pending: [] });
    const detached = { ...assistant, mcpServers: [] } as unknown as Assistant;
    const names = conversationToolsWithDiscovery(detached, null, "inv-c1").map((tool) => tool.function.name);
    expect(names).not.toContain("mcp__create_issue");
    expect(readToolActivationFrom(db, "inv-c1")).toEqual({ active: [], pending: [] });
  });

  test("pi 通路:禁用后装配即清理,重新启用后 search → 轮边界激活", () => {
    install(true);
    writeToolActivationInto(db, "inv-c1", { active: ["mcp__create_issue"], pending: [] });
    const base = [piTool("read"), piTool("mcp__create_issue")];
    expect(assemblePiToolDiscovery(base, assistant, "inv-c1").initialActiveNames).toContain("mcp__create_issue");

    install(false);
    const disabled = assemblePiToolDiscovery([piTool("read")], assistant, "inv-c1");
    expect(disabled.initialActiveNames).toBe(null);
    expect(readToolActivationFrom(db, "inv-c1")).toEqual({ active: [], pending: [] });

    install(true);
    runSearchToolsTool(assistant, { query: "issue" }, { conversationId: "inv-c1" });
    const assembly = assemblePiToolDiscovery(base, assistant, "inv-c1");
    // 命中只登记 pending:本轮的激活名单不包含它,轮边界刷新才生效。
    expect(assembly.initialActiveNames).not.toContain("mcp__create_issue");
    expect(assembly.refreshActiveNames?.() ?? []).toContain("mcp__create_issue");
  });
});
