// api/agent-runs-routes.test.ts — O1 运行历史只读路由契约
//
// 钉住:列表与事件页的形状、run 归属校验(跨会话 404)、非法游标 400、
// limit 服务端钳制、只读路由不产生任何写入。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agent-runs-routes-"));

import type { Conversation } from "../foundation/types";

const conversations = await import("../conversations");
const { configureWorkingSet, registerConversation } = await import("../conversations/working-set");
const { appendRunEvent, insertRun } = await import("../agent-loop/run-store");
const { handleConversationRoutes } = await import("./handlers/conversations");

const db = conversations.openConversationsDb();

function seedConversationRow(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

function makeConversation(id: string): Conversation {
  return {
    id,
    assistantId: "a1",
    title: id,
    systemPrompt: null,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  } as unknown as Conversation;
}

const registry = new Map<string, Conversation>();
for (const id of ["route-a", "route-b"]) {
  seedConversationRow(id);
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

insertRun({ id: "run-a1", conversationId: "route-a", nodeId: null, engine: "chat", startedAt: 100 });
insertRun({ id: "run-a2", conversationId: "route-a", nodeId: null, engine: "chat", startedAt: 200 });
insertRun({ id: "run-b1", conversationId: "route-b", nodeId: null, engine: "chat", startedAt: 300 });
for (let i = 1; i <= 5; i += 1) appendRunEvent("run-a1", "round", `第 ${i} 轮`, { round: i });
appendRunEvent("run-b1", "run_started", "开始");

afterAll(() => {
  db.prepare("DELETE FROM pc_conversation WHERE id IN ('route-a','route-b')").run();
});

async function call(target: string): Promise<{ status: number; body: any }> {
  const [path, query = ""] = target.split("?");
  const url = new URL(`http://127.0.0.1/api/${path}${query ? `?${query}` : ""}`);
  const response = await handleConversationRoutes(new Request(url), url, path);
  if (!response) throw new Error(`路由未命中: ${target}`);
  return { status: response.status, body: await response.json() };
}

describe("GET agent-runs 列表", () => {
  test("按 startedAt DESC,id DESC 返回保留 run,不含事件", async () => {
    const { status, body } = await call("conversations/route-a/agent-runs");
    expect(status).toBe(200);
    expect(body.runs.map((run: { id: string }) => run.id)).toEqual(["run-a2", "run-a1"]);
    expect(body.runs[0].events).toBeUndefined();
    expect(body.runs[0].conversationId).toBe("route-a");
  });

  test("会话不存在返回 404", async () => {
    expect((await call("conversations/route-ghost/agent-runs")).status).toBe(404);
  });
});

describe("GET agent-runs/:runId/events 分页", () => {
  test("不带游标返回最新一页与窗口信息", async () => {
    const { status, body } = await call("conversations/route-a/agent-runs/run-a1/events?limit=2");
    expect(status).toBe(200);
    expect(body.runId).toBe("run-a1");
    expect(body.events.map((event: { seq: number }) => event.seq)).toEqual([4, 5]);
    expect(body.hasMore).toBe(true);
    expect(body.nextBeforeSeq).toBe(4);
    expect(body.throughSeq).toBe(5);
  });

  test("严格 beforeSeq 向前翻页", async () => {
    const { body } = await call("conversations/route-a/agent-runs/run-a1/events?beforeSeq=4&limit=2");
    expect(body.events.map((event: { seq: number }) => event.seq)).toEqual([2, 3]);
    expect(body.hasMore).toBe(true);
    expect(body.nextBeforeSeq).toBe(2);
    expect(body.throughSeq).toBe(3);
  });

  test("非法游标 400;非法 limit 由服务端钳制而不报错", async () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      const response = await call(
        `conversations/route-a/agent-runs/run-a1/events?beforeSeq=${encodeURIComponent(bad)}`,
      );
      expect(response.status).toBe(400);
    }
    const clamped = await call("conversations/route-a/agent-runs/run-a1/events?limit=0");
    expect(clamped.status).toBe(200);
    expect(clamped.body.events).toHaveLength(5);
  });

  test("跨会话或未知 runId 一律 404", async () => {
    expect((await call("conversations/route-b/agent-runs/run-a1/events")).status).toBe(404);
    expect((await call("conversations/route-a/agent-runs/run-b1/events")).status).toBe(404);
    expect((await call("conversations/route-a/agent-runs/ghost/events")).status).toBe(404);
  });
});

describe("只读路由不产生写入", () => {
  test("连续读取后 run/事件行数不变", async () => {
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [count("pc_generation_run"), count("pc_generation_run_event")];
    await call("conversations/route-a/agent-runs");
    await call("conversations/route-a/agent-runs/run-a1/events?limit=2");
    await call("conversations/route-a/agent-run");
    expect([count("pc_generation_run"), count("pc_generation_run_event")]).toEqual(before);
  });
});
