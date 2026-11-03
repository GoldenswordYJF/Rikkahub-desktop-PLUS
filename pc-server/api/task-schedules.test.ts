// api/task-schedules.test.ts — 生命周期 L3:任务调度 CRUD 路由契约
//
// 钉住:归属校验(404)、输入校验(400)、每会话上限(429)、PATCH 语义(只改目标
// 不重排/改规则才重算)、DELETE 只删调度不动历史 run。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-task-schedules-"));

import type { Conversation, State } from "../foundation/types";

const conversations = await import("../conversations");
const { configureWorkingSet, registerConversation } = await import("../conversations/working-set");
const { setState, state } = await import("../persistence/json-store");
const { insertRun } = await import("../agent-loop/run-store");
const { handleConversationRoutes } = await import("./handlers/conversations");

const priorState = state;
const db = conversations.openConversationsDb();
const CONV = "sched-route-a";

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

seedConversationRow(CONV);
const conversation = makeConversation(CONV);
registerConversation(conversation);

function seedConversationRow(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

beforeAll(() => {
  setState({ settings: { assistantId: "a1", assistants: [], chatModelId: "" } } as unknown as State);
  configureWorkingSet({
    loadConversation: (id) => (id === CONV ? conversation : undefined),
    isGenerating: () => false,
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

afterAll(() => {
  setState(priorState);
  db.prepare("DELETE FROM pc_task_schedule WHERE conversation_id = ?").run(CONV);
  db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
});

async function call(target: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://127.0.0.1/api/${target}`);
  const request = new Request(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
  const response = await handleConversationRoutes(request, url, target);
  if (!response) throw new Error(`路由未命中: ${method} ${target}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("task-schedules CRUD", () => {
  test("创建 once/interval 并列出;未知会话 404", async () => {
    const once = await call(`conversations/${CONV}/task-schedules`, "POST", {
      goal: "明天提醒",
      kind: "once",
      runAt: Date.now() + 3_600_000,
    });
    expect(once.status).toBe(201);
    expect(once.body.schedule).toMatchObject({ goal: "明天提醒", kind: "once", enabled: true });

    const interval = await call(`conversations/${CONV}/task-schedules`, "POST", {
      goal: "每小时巡检",
      kind: "fixed_interval",
      intervalSeconds: 3600,
      misfirePolicy: "skip",
    });
    expect(interval.status).toBe(201);
    expect(interval.body.schedule).toMatchObject({ misfirePolicy: "skip", intervalSeconds: 3600 });

    const list = await call(`conversations/${CONV}/task-schedules`);
    expect(list.status).toBe(200);
    expect(list.body.schedules).toHaveLength(2);

    expect((await call(`conversations/ghost/task-schedules`)).status).toBe(404);
    expect(
      (await call(`conversations/ghost/task-schedules`, "POST", { goal: "x", kind: "fixed_interval", intervalSeconds: 60 }))
        .status,
    ).toBe(404);
  });

  test("输入校验:空目标/过去时间/越界间隔 400", async () => {
    const base = `conversations/${CONV}/task-schedules`;
    expect((await call(base, "POST", { goal: "  ", kind: "fixed_interval", intervalSeconds: 60 })).status).toBe(400);
    expect((await call(base, "POST", { goal: "x", kind: "once", runAt: 1 })).status).toBe(400);
    expect((await call(base, "POST", { goal: "x", kind: "once" })).status).toBe(400);
    expect((await call(base, "POST", { goal: "x", kind: "fixed_interval", intervalSeconds: 30 })).status).toBe(400);
    expect((await call(base, "POST", { goal: "x", kind: "fixed_interval", intervalSeconds: 1.5 })).status).toBe(400);
    expect((await call(base, "POST", { goal: "x", kind: "cron", intervalSeconds: 60 })).status).toBe(400);
    expect(
      (await call(base, "POST", { goal: "x", kind: "fixed_interval", intervalSeconds: 60, misfirePolicy: "always" }))
        .status,
    ).toBe(400);
  });

  test("PATCH/DELETE:归属校验、只改目标不重排、DELETE 不动历史 run", async () => {
    const created = await call(`conversations/${CONV}/task-schedules`, "POST", {
      goal: "原始目标",
      kind: "fixed_interval",
      intervalSeconds: 600,
    });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id as string;
    const nextRunAt = created.body.schedule.nextRunAt as number;

    const patched = await call(`conversations/${CONV}/task-schedules/${scheduleId}`, "PATCH", {
      goal: "改目标",
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.schedule).toMatchObject({ goal: "改目标", enabled: false, nextRunAt });

    const rescheduled = await call(`conversations/${CONV}/task-schedules/${scheduleId}`, "PATCH", {
      intervalSeconds: 1200,
    });
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body.schedule.nextRunAt).toBeGreaterThan(nextRunAt);

    // 归属校验:别的会话看不到也改不了这条。
    expect((await call(`conversations/ghost/task-schedules/${scheduleId}`, "PATCH", { goal: "x" })).status).toBe(404);

    insertRun({ id: "run-keep", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 1 });
    expect((await call(`conversations/${CONV}/task-schedules/${scheduleId}`, "DELETE")).status).toBe(204);
    expect((await call(`conversations/${CONV}/task-schedules/${scheduleId}`, "DELETE")).status).toBe(404);
    // 历史 run 不受影响
    const runs = db.prepare("SELECT COUNT(*) AS n FROM pc_generation_run WHERE conversation_id = ?").get(CONV) as {
      n: number;
    };
    expect(runs.n).toBe(1);
    db.prepare("DELETE FROM pc_generation_run WHERE id = 'run-keep'").run();
  });

  test("每会话上限 20 条:第 21 条 429", async () => {
    db.prepare("DELETE FROM pc_task_schedule WHERE conversation_id = ?").run(CONV);
    for (let i = 0; i < 20; i += 1) {
      const created = await call(`conversations/${CONV}/task-schedules`, "POST", {
        goal: `任务 ${i}`,
        kind: "fixed_interval",
        intervalSeconds: 60,
      });
      expect(created.status).toBe(201);
    }
    const overflow = await call(`conversations/${CONV}/task-schedules`, "POST", {
      goal: "第 21 条",
      kind: "fixed_interval",
      intervalSeconds: 60,
    });
    expect(overflow.status).toBe(429);
  });
});
