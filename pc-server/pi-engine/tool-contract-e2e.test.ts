// pi-engine/tool-contract-e2e.test.ts — S12 工具面端到端验收(零计费 mock)
//
// 一条真实的 pi 会话循环串起本期全部工具面能力,上游由假 OpenAI SSE 剧本驱动,
// MCP 走本地 HTTP 假服务器,零外网、零计费:
//   发现(S10:首轮无 MCP schema → search_tools → 下一轮激活)
//   → 调用(S11 同一实时池 → MCP tools/call → 结果回灌)
//   → 分页续读(S2:行号 + revision + nextOffset → end of file)
//   → 重读去重(S4:同文件同参数二次读取 → [unchanged: … ref #…])
//   → 压缩后回全文(S4:新 session 里原全文不在场 → 必须回全文,即使 revision 未变)
//   → 批量读取(S7:逐项完成/逐项错误互不牵连)
//   → 编辑冲突(S3:持旧 revision 编辑被拒并拿到当前 revision;重读后重试成功)
//
// 断言同时看两侧:上游请求体(模型真正看到的工具/结果)与磁盘(写入是否发生)。

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-tool-e2e-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const { workspaceRuntimeForConversation } = await import("../workspace/runtime");
const { createPiWorkspaceTools } = await import("./workspace-tools");
const { createPiGeneralTools } = await import("./general-tools");
const { assemblePiToolDiscovery } = await import("./tool-discovery");
const { runPiGeneration } = await import("./runner");
const { model, provider } = await import("../model-providers");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const { setState } = await import("../persistence/json-store");
const { readToolActivation } = await import("../conversations/tool-activation");
const { sha256Short } = await import("../workspace/ops/revision");

import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";
import type { GenerationEvent } from "../inference-engine/events";
import type { ReadEvidenceHandle } from "../workspace/ops/read-dedup";
import type { Assistant, State } from "../foundation/types";

const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: () => false,
  hasSseClients: () => false,
  hasDirty: () => false,
});

// ----- 本地假 MCP 服务器(Streamable HTTP 最小形状;与 request-chain-smoke 同款) -----

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

const mcp = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, any>;
    if (body.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "e2e-mcp", version: "1.0.0" },
        },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "e2e_echo",
              description: "Echo a fixed marker back; used by the end-to-end acceptance run.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
    }
    if (body.method === "tools/call") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `MCP_RESULT:${body.params?.arguments?.text ?? ""}` }] },
      });
    }
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  },
});

afterAll(() => {
  mcp.stop(true);
});

// ----- fixtures -----

const assistant = {
  id: "e2e-assistant",
  name: "E2E",
  systemPrompt: "",
  messageTemplate: "{{ message }}",
  enableMemory: false,
  memoryWriteScope: "readonly",
  localTools: [],
  enabledSkills: [],
  mcpServers: ["e2e-mcp"],
  mcpToolOverrides: {},
  enableToolDiscovery: true,
  reasoningLevel: "low",
} as unknown as Assistant;

setState({
  settings: {
    enableWebSearch: false,
    mcpServers: [
      {
        id: "e2e-mcp",
        type: "streamable_http",
        url: `http://127.0.0.1:${mcp.port}/mcp`,
        commonOptions: {
          name: "E2E MCP",
          enable: true,
          tools: [
            {
              name: "e2e_echo",
              description: "Echo a fixed marker back; used by the end-to-end acceptance run.",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              enable: true,
              needsApproval: false,
            },
          ],
        },
      },
    ],
    memorySettings: { globalEnabled: false, writeStrategy: "ask", dedupEnabled: false, memoryModelThinkingEnabled: false },
    subagent: { enabled: false },
    // 本期全部开关打开(生产默认关;验收必须覆盖开启路径)。
    workspaceTools: {
      readContract: true,
      readDedup: true,
      searchCoverage: true,
      toolDiscovery: true,
      resumableOutput: true,
      mcpDescriptionCap: false,
    },
    assistants: [assistant],
    assistantId: assistant.id,
  },
  // MCP 调用会 addLog(读 state.stats/logs):测试进程未跑 bootstrap,补最小字段。
  stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
  logs: [],
} as unknown as State);

const workspace = ws.createWorkspace({ type: "managed", name: "tool-contract-e2e" });
const conversation = {
  id: "tool-contract-e2e-conv",
  assistantId: assistant.id,
  systemPrompt: null,
  title: "tool contract e2e",
  messages: [],
  chatSuggestions: [],
  isPinned: false,
  createAt: 1000,
  updateAt: 2000,
  workspaceId: workspace.id,
  workspaceCwd: null,
};
conversations.persistConversation(conversation);

const NOTES = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
const BIG = Array.from({ length: 30 }, (_, index) => `row ${index + 1} ${"x".repeat(24)}`).join("\n") + "\n";
const STABLE = "stable-line\nsecond-line\n";
writeFileSync(join(workspace.root, "notes.txt"), NOTES);
writeFileSync(join(workspace.root, "big.txt"), BIG);
writeFileSync(join(workspace.root, "stable.txt"), STABLE);

const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
const notesRevision = sha256Short(readFileSync(join(workspace.root, "notes.txt")));
const afterExternalEdit = `${NOTES}eta\n`;
const afterExternalRevision = sha256Short(Buffer.from(afterExternalEdit));

function buildTools(sink: (event: GenerationEvent) => void, readEvidence: ReadEvidenceHandle) {
  const baseTools = [
    ...createPiWorkspaceTools({ conversation: conversation as never, assistant, sink, readEvidence }),
    ...createPiGeneralTools({ conversation: conversation as never, assistant, sink, model: null }),
  ];
  const discovery = assemblePiToolDiscovery(baseTools, assistant, conversation.id);
  return { discovery, baseTools };
}

function requestTools(request: Record<string, unknown> | undefined): string[] {
  const tools = Array.isArray(request?.tools) ? request.tools as Array<{ function?: { name?: string } }> : [];
  return tools.map((tool) => String(tool.function?.name ?? ""));
}

// 工具结果只在 messages 里断言:tools[].description 也提到 [unchanged:]/nextOffset 等字样,
// 对整包 JSON 做 contains 会把 schema 文案误当工具产出。
function toolResultText(request: Record<string, unknown> | undefined, callId: string): string {
  const messages = Array.isArray(request?.messages)
    ? request.messages as Array<{ role?: string; tool_call_id?: string; content?: unknown }>
    : [];
  const message = messages.find((item) => item.role === "tool" && item.tool_call_id === callId);
  return JSON.stringify(message?.content ?? "");
}

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("S12 工具面端到端(mock,零计费)", () => {
  test("发现 → 调用 → 分页/去重 → 批量 → 冲突 → 压缩后回全文", async () => {
    const turns: FakeSseTurn[] = [
      { toolCalls: [{ id: "tc-search", name: "search_tools", arguments: JSON.stringify({ query: "echo" }) }] },
      { toolCalls: [{ id: "tc-mcp", name: "mcp__e2e_echo", arguments: JSON.stringify({ text: "ping" }) }] },
      { toolCalls: [{ id: "tc-read-1", name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 3 }) }] },
      { toolCalls: [{ id: "tc-read-2", name: "read", arguments: JSON.stringify({ path: "notes.txt", offset: 4, limit: 10 }) }] },
      { toolCalls: [{ id: "tc-big-1", name: "read", arguments: JSON.stringify({ path: "big.txt", limit: 20 }) }] },
      { toolCalls: [{ id: "tc-big-2", name: "read", arguments: JSON.stringify({ path: "big.txt", limit: 20 }) }] },
      { toolCalls: [{ id: "tc-stable", name: "read", arguments: JSON.stringify({ path: "stable.txt" }) }] },
      {
        toolCalls: [{
          id: "tc-batch",
          name: "read_files",
          arguments: JSON.stringify({ files: [{ path: "notes.txt", limit: 2 }, { path: "missing.txt" }] }),
        }],
      },
      {
        // 外部(侧边栏/另一个进程)在模型决定编辑的同一时刻改文件:beforeRespond 落盘,
        // 随后 edit 用旧 revision 必须被拒,证明校验发生在写队列内而不是仅凭参数记忆。
        beforeRespond: () => writeFileSync(join(workspace.root, "notes.txt"), afterExternalEdit),
        toolCalls: [{
          id: "tc-edit-stale",
          name: "edit",
          arguments: JSON.stringify({ path: "notes.txt", oldText: "beta", newText: "BETA", expectedRevision: notesRevision }),
        }],
      },
      {
        // 重试轮请求到达时,冲突轮的工具已执行完毕;此刻磁盘必须仍是外部写入的内容。
        beforeRespond: () => {
          diskAtRetry = readFileSync(join(workspace.root, "notes.txt"), "utf8");
        },
        toolCalls: [{
          id: "tc-edit-retry",
          name: "edit",
          arguments: JSON.stringify({ path: "notes.txt", oldText: "beta", newText: "BETA", expectedRevision: afterExternalRevision }),
        }],
      },
      { content: "E2E done" },
    ];
    const server = await startFakeOpenAiSse(turns);
    servers.push(server);
    const events: GenerationEvent[] = [];
    const sink = (event: GenerationEvent) => void events.push(event);
    const readEvidence: ReadEvidenceHandle = {};
    // 冲突轮之后、重试轮之前的磁盘快照:证明被拒的编辑一字未写。
    let diskAtRetry = "";
    const { discovery } = buildTools(sink, readEvidence);

    const result = await runPiGeneration({
      provider: provider({ id: crypto.randomUUID(), name: "E2E Provider", baseUrl: server.baseUrl, apiKey: "sk-test" }),
      model: model("fake-model", "E2E Model"),
      conversationId: conversation.id,
      cwd,
      history: [],
      promptText: "跑完工具面验收",
      tools: discovery.tools,
      ...(discovery.initialActiveNames ? { activeToolNames: discovery.initialActiveNames } : {}),
      ...(discovery.refreshActiveNames ? { onToolActivationBoundary: discovery.refreshActiveNames } : {}),
      readEvidence,
      sink,
    });

    expect(result.text).toBe("E2E done");
    expect(server.requests).toHaveLength(turns.length);

    // ① 发现:首轮请求不带 MCP schema,search_tools 在;搜索后轮边界激活,下一轮带上。
    const first = requestTools(server.requests[0]);
    expect(first).toContain("search_tools");
    expect(first).toContain("read");
    expect(first).toContain("read_files");
    expect(first).toContain("edit");
    expect(first).not.toContain("mcp__e2e_echo");
    expect(requestTools(server.requests[1])).toContain("mcp__e2e_echo");
    expect(readToolActivation(conversation.id)).toEqual({ active: ["mcp__e2e_echo"], pending: [] });

    // ② 调用:发现结果回灌模型 → MCP 结果进下一轮请求。
    expect(toolResultText(server.requests[1], "tc-search")).toContain("Loaded from the next round");
    expect(toolResultText(server.requests[2], "tc-mcp")).toContain("MCP_RESULT:ping");

    // ③ 分页续读:第一页带行号/revision/nextOffset,第二页到 end of file。
    const readPage1 = toolResultText(server.requests[3], "tc-read-1");
    expect(readPage1).toContain("1|alpha");
    expect(readPage1).toContain("more lines; nextOffset=4");
    const readPage2 = toolResultText(server.requests[4], "tc-read-2");
    expect(readPage2).toContain("4|delta");
    expect(readPage2).toContain("end of file");

    // ④ 重读去重:同参数二次读取 → 一行引用,指向上一轮全文。
    expect(toolResultText(server.requests[5], "tc-big-1")).toContain("20|row 20");
    const dedup = toolResultText(server.requests[6], "tc-big-2");
    expect(dedup).toContain("[unchanged:");
    expect(dedup).toContain("ref #");

    // ⑤ 批量读取:命中项带行号,缺失项单独报错,不牵连。
    const batch = toolResultText(server.requests[8], "tc-batch");
    expect(batch).toContain("### notes.txt");
    expect(batch).toContain("1|alpha");
    expect(batch).toContain("### missing.txt");
    expect(batch).toContain("Error:");

    // ⑥ 编辑冲突:旧 revision 被拒并给出当前 revision;磁盘未被改。
    const conflict = toolResultText(server.requests[9], "tc-edit-stale");
    expect(conflict).toContain("Edit rejected");
    expect(conflict).toContain(notesRevision);
    expect(conflict).toContain(afterExternalRevision);
    expect(conflict).toContain("effectState: none");
    expect(diskAtRetry).toBe(afterExternalEdit);

    // ⑦ 用当前 revision 重试成功,回执带新 revision。
    expect(toolResultText(server.requests[10], "tc-edit-retry")).toContain("New revision:");
    const edited = readFileSync(join(workspace.root, "notes.txt"), "utf8");
    expect(edited).toContain("BETA");
    expect(edited).not.toContain("\nbeta\n");

    // ⑧ 压缩后回全文:新 session(原全文不在即将发送的消息里)重读未变的 stable.txt,
    //    即使 revision 与去重登记一致,也必须回全文——证据不足一律全文,这是 S4 的
    //    最高优先级正确性约束。这里用空 history 模拟压缩后视图(原工具结果被摘要替代)。
    const stableServer = await startFakeOpenAiSse([
      { toolCalls: [{ id: "tc-stable-2", name: "read", arguments: JSON.stringify({ path: "stable.txt" }) }] },
      { content: "压缩后重读完成" },
    ]);
    servers.push(stableServer);
    const stableEvidence: ReadEvidenceHandle = {};
    const { discovery: stableDiscovery } = buildTools(sink, stableEvidence);
    const stableResult = await runPiGeneration({
      provider: provider({ id: crypto.randomUUID(), name: "E2E Provider", baseUrl: stableServer.baseUrl, apiKey: "sk-test" }),
      model: model("fake-model", "E2E Model"),
      conversationId: conversation.id,
      cwd,
      history: [],
      promptText: "压缩后重读 stable.txt",
      tools: stableDiscovery.tools,
      ...(stableDiscovery.initialActiveNames ? { activeToolNames: stableDiscovery.initialActiveNames } : {}),
      ...(stableDiscovery.refreshActiveNames ? { onToolActivationBoundary: stableDiscovery.refreshActiveNames } : {}),
      readEvidence: stableEvidence,
      sink,
    });
    expect(stableResult.text).toBe("压缩后重读完成");
    const reread = toolResultText(stableServer.requests[1], "tc-stable-2");
    expect(reread).toContain("1|stable-line");
    expect(reread).toContain("[revision=");
    expect(reread).not.toContain("[unchanged:");
    expect(readFileSync(join(workspace.root, "stable.txt"), "utf8")).toBe(STABLE);
  }, 60_000);
});
