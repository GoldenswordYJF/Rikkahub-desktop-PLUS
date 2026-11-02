// pi-engine/tool-discovery.test.ts — S10 pi 通路发现行(纯装配层)
//
// 覆盖:关闭/无会话/无池 = 原数组原样返回且不激活(行为与引入前逐字一致);
// 开启 = 全集注册 + search_tools 插在 MCP 段首位 + 首轮只激活核心面;
// search_tools 的查询文本与命中语义复用 tools/discovery(与聊天通路一致)。
// 激活集落库/提升的完整闭环在 runner-tools.test.ts 的集成用例(真 DB + 真 pi 会话)。

import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant } from "../foundation/types";
import { assemblePiToolDiscovery, piDiscoveryPool } from "./tool-discovery";

const assistant = { id: "a1", enableToolDiscovery: true } as unknown as Assistant;

function tool(name: string, description = ""): ToolDefinition {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute() {
      return { content: [{ type: "text", text: `ran:${name}` }], details: {} };
    },
  };
}

function baseTools(): ToolDefinition[] {
  return [tool("read"), tool("bash"), tool("mcp__github__create_issue", "Create a GitHub issue"), tool("mcp__db__query", "Run a SQL query")];
}

describe("assemblePiToolDiscovery", () => {
  test("开关关闭 / 无会话 / 无 MCP 池:原数组原样返回,不激活", () => {
    const tools = baseTools();
    const off = { ...assistant, enableToolDiscovery: false } as unknown as Assistant;
    const closed = assemblePiToolDiscovery(tools, off, "s10-off");
    expect(closed.tools).toBe(tools);
    expect(closed.initialActiveNames).toBeNull();
    expect(closed.refreshActiveNames).toBeUndefined();

    const noConv = assemblePiToolDiscovery(tools, assistant, null);
    expect(noConv.tools).toBe(tools);
    expect(noConv.initialActiveNames).toBeNull();

    const noPool = [tool("read"), tool("bash")];
    const empty = assemblePiToolDiscovery(noPool, assistant, "s10-nopool");
    expect(empty.tools).toBe(noPool);
    expect(empty.initialActiveNames).toBeNull();
  });

  test("开启且有池:search_tools 插在 MCP 段首位,首轮只激活核心面 + search_tools", () => {
    const tools = baseTools();
    const plan = assemblePiToolDiscovery(tools, assistant, "s10-initial");
    expect(plan.tools.map((item) => item.name)).toEqual([
      "read",
      "bash",
      "search_tools",
      "mcp__github__create_issue",
      "mcp__db__query",
    ]);
    // 未激活 MCP schema 不进首轮请求;search_tools 常驻。
    expect(plan.initialActiveNames).toEqual(["read", "bash", "search_tools"]);
    // 原数组不被就地修改。
    expect(tools.map((item) => item.name)).toEqual(["read", "bash", "mcp__github__create_issue", "mcp__db__query"]);
  });

  test("search_tools 执行:关键词命中返回与聊天通路一致的文本;空查询给指引", async () => {
    const plan = assemblePiToolDiscovery(baseTools(), assistant, "s10-exec");
    const search = plan.tools.find((item) => item.name === "search_tools")!;
    const result = await search.execute("tc1", { query: "github issue" } as never, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("mcp__github__create_issue");
    expect(text).toContain("next round");

    const empty = await search.execute("tc2", { query: "" } as never, undefined, undefined, {} as never);
    expect((empty.content[0] as { text: string }).text).toContain("non-empty");
  });

  test("无 pending 时轮边界刷新返回 null(不重设激活集)", () => {
    const plan = assemblePiToolDiscovery(baseTools(), assistant, "s10-refresh-empty");
    expect(plan.refreshActiveNames!()).toBeNull();
  });
});

describe("piDiscoveryPool", () => {
  test("只收 mcp__ 前缀,描述用于匹配文本", () => {
    const pool = piDiscoveryPool(baseTools());
    expect(pool.map((item) => item.name)).toEqual(["mcp__github__create_issue", "mcp__db__query"]);
    expect(pool[0]!.description).toBe("Create a GitHub issue");
  });
});
