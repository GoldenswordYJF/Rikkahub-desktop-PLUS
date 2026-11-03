// api/agent-run-audit.test.ts — 生命周期 L4:跨会话审计查询与单 run JSONL 导出
//
// 钉住:筛选(状态/引擎/会话/调度)、稳定分页游标、非法参数 400、空结果形状、
// 导出首行 run + seq 升序事件 + 末行 projection、跨会话 404、只读不写。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agent-run-audit-"));

import type { Conversation } from "../foundation/types";

const conversations = await import("../conversations");
const { configureWorkingSet, registerConversation } = await import("../conversations/working-set");
const { appendRunEvent, insertRun, updateRun } = await import("../agent-loop/run-store");
const { handleConversationRoutes } = await import("./handlers/conversations");
const { routeApi } = await import("./router");

const db = conversations.openConversationsDb();
const CONV = "audit-a";
const OTHER = "audit-b";

function seedConversation(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

function makeConversation(id: string): Conversation {
  return {
    id, assistantId: "a1", title: id, systemPrompt: null, messages: [],
    chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1,
  } as unknown as Conversation;
}

const registry = new Map<string, Conversation>();
for (const id of [CONV, OTHER]) {
  seedConversation(id);
  const conversation = makeConversation(id);
  registry.set(id, conversation);
  registerConversation(conversation);
}
configureWorkingSet({
  loadConversation: (conversationId) => registry.get(conversationId),
  isGenerating: () => false,
  hasSseClients: () => false,
  hasDirty: () => false,
});

// 5 条 run:不同 startedAt,覆盖状态/引擎/调度筛选。
const RUNS = [
  { id: "ar-1", conversationId: CONV, engine: "chat", startedAt: 100, status: "succeeded" },
  { id: "ar-2", conversationId: CONV, engine: "pi", startedAt: 200, status: "stopped", stopReason: "interrupted" },
  { id: "ar-3", conversationId: OTHER, engine: "chat", startedAt: 300, status: "failed" },
  { id: "ar-4", conversationId: OTHER, engine: "chat", startedAt: 400, status: "succeeded" },
  { id: "ar-5", conversationId: CONV, engine: "chat", startedAt: 500, status: "running" },
] as const;

for (const run of RUNS) {
  insertRun({
    id: run.id,
    conversationId: run.conversationId,
    nodeId: null,
    engine: run.engine,
    startedAt: run.startedAt,
    scheduleId: run.id === "ar-2" ? "schedule-x" : null,
  });
  updateRun(run.id, {
    status: run.status as never,
    ...("stopReason" in run ? { stopReason: run.stopReason } : {}),
    endedAt: run.status === "running" ? null : run.startedAt + 10,
  });
}
appendRunEvent("ar-2", "run_started", "开始");
appendRunEvent("ar-2", "round", "第 1 轮", { round: 1 });
appendRunEvent("ar-2", "run_finished", "已停止", { status: "stopped", reason: "process_restart" });

afterAll(() => {
  db.prepare("DELETE FROM pc_conversation WHERE id IN (?, ?)").run(CONV, OTHER);
});

async function audit(query = ""): Promise<{ status: number; body: any }> {
  const url = new URL(`http://127.0.0.1/api/agent-runs${query ? `?${query}` : ""}`);
  const response = await routeApi(new Request(url), url);
  if (!response) throw new Error("路由未命中");
  return { status: response.status, body: await response.json() };
}

describe("GET /api/agent-runs 跨会话查询", () => {
  test("默认按 startedAt DESC 返回摘要;支持状态/引擎/会话/调度筛选", async () => {
    const all = await audit();
    expect(all.status).toBe(200);
    expect(all.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-5", "ar-4", "ar-3", "ar-2", "ar-1"]);
    expect(all.body.runs[0].events).toBeUndefined();

    const stopped = await audit("status=stopped");
    expect(stopped.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-2"]);
    expect(stopped.body.runs[0]).toMatchObject({ stopReason: "interrupted", scheduleId: "schedule-x" });

    const pi = await audit("engine=pi");
    expect(pi.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-2"]);

    const byConversation = await audit(`conversationId=${OTHER}`);
    expect(byConversation.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-4", "ar-3"]);

    const bySchedule = await audit("scheduleId=schedule-x");
    expect(bySchedule.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-2"]);
  });

  test("稳定分页:游标翻页不重不漏,末页 nextBefore* 为 null", async () => {
    const first = await audit("limit=2");
    expect(first.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-5", "ar-4"]);
    expect(first.body.nextBeforeStartedAt).toBe(400);
    expect(first.body.nextBeforeId).toBe("ar-4");

    const second = await audit(
      `limit=2&beforeStartedAt=${first.body.nextBeforeStartedAt}&beforeId=${first.body.nextBeforeId}`,
    );
    expect(second.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-3", "ar-2"]);

    const third = await audit(
      `limit=2&beforeStartedAt=${second.body.nextBeforeStartedAt}&beforeId=${second.body.nextBeforeId}`,
    );
    expect(third.body.runs.map((run: { id: string }) => run.id)).toEqual(["ar-1"]);
    expect(third.body.nextBeforeStartedAt).toBeNull();
    expect(third.body.nextBeforeId).toBeNull();
  });

  test("空结果形状与非法参数", async () => {
    const empty = await audit("status=exhausted");
    expect(empty.body).toEqual({ runs: [], nextBeforeStartedAt: null, nextBeforeId: null });

    expect((await audit("status=bogus")).status).toBe(400);
    expect((await audit("beforeStartedAt=0")).status).toBe(400);
    expect((await audit("beforeStartedAt=abc")).status).toBe(400);
    expect((await audit("limit=abc")).status).toBe(400);
  });
});

describe("GET 单 run JSONL 导出", () => {
  async function exportRun(conversationId: string, runId: string): Promise<Response> {
    const path = `conversations/${conversationId}/agent-runs/${runId}/export`;
    const url = new URL(`http://127.0.0.1/api/${path}`);
    const response = await handleConversationRoutes(new Request(url), url, path);
    if (!response) throw new Error("路由未命中");
    return response;
  }

  test("首行 run、事件 seq 升序、末行 projection;内容类型 NDJSON", async () => {
    const response = await exportRun(CONV, "ar-2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toContain(".ndjson");

    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "run", data: { id: "ar-2" } });
    const events = lines.filter((line) => line.type === "event");
    expect(events.map((line) => line.data.seq)).toEqual([1, 2, 3]);
    expect(lines.at(-1)).toMatchObject({ type: "projection", data: { runId: "ar-2" } });
    // 事件只带摘要/小载荷,不含消息正文
    expect(JSON.stringify(lines)).not.toContain("\"parts\"");
  });

  test("跨会话/未知 run 一律 404,不用空导出掩盖越权", async () => {
    expect((await exportRun(OTHER, "ar-2")).status).toBe(404);
    expect((await exportRun(CONV, "ghost")).status).toBe(404);
    expect((await exportRun("ghost-conv", "ar-2")).status).toBe(404);
  });
});
