// conversations/discovery-refresh.test.ts — S9 轮边界刷新回归(聊天通路)
//
// 覆盖 callProvider 内 refreshBodyToolsForDiscovery 的四条纪律:
//  ① 请求体与"刷新前应得形状"逐字相等 → 提升 pending,新 schema 进下一轮;
//  ② 无 pending → 不碰请求体;
//  ③ 用户 customBodies 定制的 tools(逐字不等)→ 不提升、不改写;
//  ④ 待激活工具在轮间被关停(S11)→ 先清理再判定,不产生半状态。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-discovery-refresh-"));

const conversations = await import("./index");
const { setState } = await import("../persistence/json-store");
const { conversationFunctionTools } = await import("../tools/bound");
const { applyToolDiscovery } = await import("../tools/discovery");
const { readToolActivationFrom, registerPendingToolActivationIn, writeToolActivationInto } = await import("./tool-activation");
const { refreshBodyToolsForDiscovery } = await import("./orchestrator");

import type { FunctionToolDeclaration } from "../tools/discovery";
import type { Assistant, JsonValue, Model, Provider, State } from "../foundation/types";

const db = conversations.openConversationsDb();
const conversationId = "discovery-refresh-c1";
db.prepare(
  "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, 'a1', '', '', '[]', 0, 1, 1)",
).run(conversationId);

function installState(tools: { createIssue?: boolean; listPrs?: boolean } = {}): void {
  const createIssue = tools.createIssue !== false;
  const listPrs = tools.listPrs !== false;
  setState({
    settings: {
      enableWebSearch: false,
      mcpServers: [
        {
          id: "srv",
          type: "streamable_http",
          url: "http://127.0.0.1:1/mcp",
          commonOptions: {
            name: "Fixture",
            enable: true,
            tools: [
              { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: {} }, enable: createIssue },
              { name: "list_prs", description: "List pull requests", inputSchema: { type: "object", properties: {} }, enable: listPrs },
            ],
          },
        },
      ],
      memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
      subagent: { enabled: false },
      workspaceTools: {},
      assistants: [],
      assistantId: "a1",
    },
  } as unknown as State);
}

function assistantFixture(): Assistant {
  return {
    id: "a1",
    name: "A",
    mcpServers: ["srv"],
    mcpToolOverrides: {},
    localTools: [],
    enabledSkills: [],
    enableMemory: false,
    memoryWriteScope: "readonly",
    enableToolDiscovery: true,
  } as unknown as Assistant;
}

const providerItem = { id: "p1", type: "openai", name: "P" } as unknown as Provider;
const modelItem = {
  id: "m1",
  modelId: "mock",
  type: "CHAT",
  abilities: ["TOOL"],
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
} as unknown as Model;

function baseTools(assistant = assistantFixture()): FunctionToolDeclaration[] {
  return conversationFunctionTools(assistant, modelItem) as unknown as FunctionToolDeclaration[];
}

/** 首轮请求体形状:与 callProvider 首轮装配同源(激活集为空)。 */
function firstRoundBody(assistant = assistantFixture()): Record<string, unknown> {
  return {
    model: "mock",
    messages: [{ role: "user", content: "search tools" }],
    tools: applyToolDiscovery(baseTools(assistant), new Set()),
  };
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(body?.tools) ? (body.tools as Array<{ function?: { name?: string } }>) : [];
  return tools.map((tool) => String(tool.function?.name ?? ""));
}

describe("S9 轮边界刷新(聊天通路)", () => {
  test("请求体逐字一致 → 提升 pending,新工具 schema 进下一轮", () => {
    installState();
    writeToolActivationInto(db, conversationId, { active: [], pending: [] });
    const body = firstRoundBody();
    expect(toolNames(body)).not.toContain("mcp__create_issue");

    registerPendingToolActivationIn(db, conversationId, ["mcp__create_issue"]);
    const next = refreshBodyToolsForDiscovery(providerItem, modelItem, assistantFixture(), conversationId, body);

    expect(next).toBeDefined();
    expect(toolNames(next)).toContain("mcp__create_issue");
    expect(toolNames(next)).toContain("search_tools");
    expect(next?.tool_choice).toBe("auto");
    expect(readToolActivationFrom(db, conversationId)).toEqual({ active: ["mcp__create_issue"], pending: [] });
    // 原请求体不被就地修改(调用方可能仍在用旧 body 做日志/重放)。
    expect(toolNames(body)).not.toContain("mcp__create_issue");
  });

  test("无 pending → 返回 undefined,请求体零改动", () => {
    installState();
    writeToolActivationInto(db, conversationId, { active: ["mcp__create_issue"], pending: [] });
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: applyToolDiscovery(baseTools(), new Set(["mcp__create_issue"])),
    };
    expect(refreshBodyToolsForDiscovery(providerItem, modelItem, assistantFixture(), conversationId, body)).toBeUndefined();
  });

  test("用户自定义 tools(customBodies)→ 不提升、不改写", () => {
    installState();
    writeToolActivationInto(db, conversationId, { active: [], pending: [] });
    registerPendingToolActivationIn(db, conversationId, ["mcp__create_issue"]);
    const customBody = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "my_private_tool", parameters: { type: "object" } } }],
    };
    expect(refreshBodyToolsForDiscovery(providerItem, modelItem, assistantFixture(), conversationId, customBody)).toBeUndefined();
    expect(readToolActivationFrom(db, conversationId)).toEqual({ active: [], pending: ["mcp__create_issue"] });
  });

  test("待激活工具在轮间被关停 → 先清理失效项,不提升不刷新", () => {
    installState();
    writeToolActivationInto(db, conversationId, { active: [], pending: [] });
    const body = firstRoundBody();
    registerPendingToolActivationIn(db, conversationId, ["mcp__list_prs"]);
    // 轮间:该工具被关闭(实时池里已不存在)
    installState({ listPrs: false });
    expect(refreshBodyToolsForDiscovery(providerItem, modelItem, assistantFixture(), conversationId, body)).toBeUndefined();
    expect(readToolActivationFrom(db, conversationId)).toEqual({ active: [], pending: [] });
  });
});

describe("未知会话/开关关闭", () => {
  test("发现关闭或会话激活集缺失:请求体原样返回 undefined", () => {
    installState();
    const off = { ...assistantFixture(), enableToolDiscovery: false } as unknown as Assistant;
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [] as JsonValue[],
    };
    expect(refreshBodyToolsForDiscovery(providerItem, modelItem, off, conversationId, body)).toBeUndefined();
    expect(refreshBodyToolsForDiscovery(providerItem, modelItem, assistantFixture(), "missing-conversation", body)).toBeUndefined();
  });
});
