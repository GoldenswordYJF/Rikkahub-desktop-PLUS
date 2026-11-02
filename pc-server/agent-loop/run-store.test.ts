// agent-loop/run-store.test.ts — 运行记录表契约(S1 + O1)
//
// 钉住:字段落库与默认值、事件 seq 单调与摘要截断、每会话保留上限、
// 删除会话时 run/事件随之清理(显式删事件 + 行,不依赖 FK pragma)。
// O1 追加:保留列表/最新/淘汰的确定性排序(startedAt DESC, id DESC)、
// 事件游标分页(严格 beforeSeq、最新一页、窗口元信息)、跨会话归属校验。
import { afterAll, describe, expect, test } from "bun:test";

import { getConversationsDb, openConversationsDb } from "../conversations";
import { AGENT_RUN_RETENTION_PER_CONVERSATION } from "./schema";
import {
  appendRunEvent,
  getRun,
  getRunForConversation,
  getRunSnapshot,
  insertRun,
  latestRun,
  latestSuspendedRun,
  listRunEventPage,
  listRunEvents,
  listRuns,
  normalizeEventPageLimit,
  updateRun,
} from "./run-store";

const db = getConversationsDb() ?? openConversationsDb();

const CONV = `run-store-conv-${process.pid}`;
const CONV2 = `${CONV}-retention`;
const CONV3 = `${CONV}-ordering`;
const CONV4 = `${CONV}-ties`;
const CONV5 = `${CONV}-paging`;

function seedConversation(id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'a1', 't', 1, 1)",
  ).run(id);
}

for (const id of [CONV, CONV2, CONV3, CONV4, CONV5]) seedConversation(id);

afterAll(() => {
  // CASCADE 带走 run/事件;显式删除兜底(测试库可能未开 FK)
  db.prepare("DELETE FROM pc_conversation WHERE id IN (?, ?, ?, ?, ?)").run(CONV, CONV2, CONV3, CONV4, CONV5);
});

describe("run 落库", () => {
  test("插入默认 running/planning,更新字段按列映射写回", () => {
    seedConversation(CONV);
    expect(insertRun({ id: "r1", conversationId: CONV, nodeId: "n1", engine: "chat", startedAt: 100 })).toBe(true);
    const run = getRun("r1")!;
    expect(run).toMatchObject({
      id: "r1",
      conversationId: CONV,
      nodeId: "n1",
      engine: "chat",
      status: "running",
      phase: "planning",
      rounds: 0,
      attempts: 0,
      replanCount: 0,
      endedAt: null,
      error: null,
    });

    updateRun("r1", {
      status: "succeeded",
      phase: "verifying",
      rounds: 3,
      attempts: 1,
      replanCount: 2,
      goal: "目标",
      endedAt: 200,
      stopReason: "interrupted",
      error: "boom",
    });
    expect(getRun("r1")).toMatchObject({
      status: "succeeded",
      phase: "verifying",
      rounds: 3,
      attempts: 1,
      replanCount: 2,
      goal: "目标",
      endedAt: 200,
      stopReason: "interrupted",
      error: "boom",
    });
    // 空 patch 不产生 SQL(幂等空操作)
    updateRun("r1", {});
    expect(getRun("r1")!.rounds).toBe(3);
  });

  test("latestRun / latestSuspendedRun 按 started_at 取最近", () => {
    seedConversation(CONV);
    insertRun({ id: "r2", conversationId: CONV, nodeId: null, engine: "pi", startedAt: 300 });
    insertRun({ id: "r3", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 400 });
    updateRun("r2", { status: "suspended", phase: "awaiting_approval" });
    updateRun("r3", { status: "failed", endedAt: 500 });
    expect(latestRun(CONV)!.id).toBe("r3");
    expect(latestSuspendedRun(CONV)!.id).toBe("r2");
    expect(latestSuspendedRun(`${CONV}-none`)).toBeNull();
  });

  test("事件 seq 由落库方分配并单调递增;超长摘要截断", () => {
    seedConversation(CONV);
    insertRun({ id: "r4", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 600 });
    const first = appendRunEvent("r4", "round", "第 1 轮", { round: 1 })!;
    const second = appendRunEvent("r4", "tool_call", "调用工具 bash", { toolName: "bash" })!;
    const long = appendRunEvent("r4", "error", "x".repeat(500))!;
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(long.seq).toBe(3);
    expect(long.summary).toHaveLength(240);
    expect(long.summary.endsWith("…")).toBe(true);

    const events = listRunEvents("r4");
    expect(events.map((event) => event.kind)).toEqual(["round", "tool_call", "error"]);
    expect(events[1]!.payload).toEqual({ toolName: "bash" });
    expect(getRunSnapshot(CONV).events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });
});

describe("保留与清理", () => {
  test(`每会话只保留最近 ${AGENT_RUN_RETENTION_PER_CONVERSATION} 条,事件一并淘汰`, () => {
    seedConversation(CONV2);
    for (let i = 0; i < AGENT_RUN_RETENTION_PER_CONVERSATION + 3; i += 1) {
      const id = `ret-${String(i).padStart(2, "0")}`;
      expect(insertRun({ id, conversationId: CONV2, nodeId: null, engine: "chat", startedAt: 1_000 + i })).toBe(true);
      appendRunEvent(id, "run_started", "开始");
    }
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM pc_generation_run WHERE conversation_id = ?")
      .get(CONV2) as { n: number };
    expect(count.n).toBe(AGENT_RUN_RETENTION_PER_CONVERSATION);
    // 最旧三条被淘汰,事件同步清空
    expect(getRun("ret-00")).toBeNull();
    const orphanEvents = db
      .prepare("SELECT COUNT(*) AS n FROM pc_generation_run_event WHERE run_id IN ('ret-00','ret-01','ret-02')")
      .get() as { n: number };
    expect(orphanEvents.n).toBe(0);
    expect(listRunEvents("ret-03")).toHaveLength(1);
  });

  test("删除会话后 run 与事件随 CASCADE 清理", () => {
    seedConversation(CONV);
    insertRun({ id: "r-del", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 900 });
    appendRunEvent("r-del", "run_started", "开始");
    db.prepare("DELETE FROM pc_conversation WHERE id = ?").run(CONV);
    expect(getRun("r-del")).toBeNull();
    expect(listRunEvents("r-del")).toEqual([]);
    seedConversation(CONV);
  });
});

describe("保留列表与确定性排序(O1)", () => {
  test("listRuns 按 startedAt DESC, id DESC;latestRun 同一规则", () => {
    for (const [id, startedAt] of [["ord-b", 100], ["ord-c", 200], ["ord-a", 100]] as const) {
      expect(insertRun({ id, conversationId: CONV3, nodeId: null, engine: "chat", startedAt })).toBe(true);
    }
    expect(listRuns(CONV3).map((run) => run.id)).toEqual(["ord-c", "ord-b", "ord-a"]);
    expect(latestRun(CONV3)!.id).toBe("ord-c");
    // 列表不携带事件(响应体积与事件数解耦)
    expect(listRuns(CONV3)[0]).not.toHaveProperty("events");
  });

  test(`相同 startedAt:保留最近 ${AGENT_RUN_RETENTION_PER_CONVERSATION} 条按 id DESC 决胜`, () => {
    const total = AGENT_RUN_RETENTION_PER_CONVERSATION + 2;
    for (let i = 0; i < total; i += 1) {
      const id = `tie-${String(i).padStart(2, "0")}`;
      expect(insertRun({ id, conversationId: CONV4, nodeId: null, engine: "chat", startedAt: 500 })).toBe(true);
    }
    const runs = listRuns(CONV4);
    expect(runs).toHaveLength(AGENT_RUN_RETENTION_PER_CONVERSATION);
    expect(runs[0]!.id).toBe("tie-21");
    expect(runs[runs.length - 1]!.id).toBe("tie-02");
    expect(latestRun(CONV4)!.id).toBe("tie-21");
    expect(getRun("tie-00")).toBeNull();
    expect(getRun("tie-01")).toBeNull();
  });
});

describe("事件游标分页(O1)", () => {
  function seedRun(conversationId: string, runId: string, events: number): void {
    insertRun({ id: runId, conversationId, nodeId: null, engine: "chat", startedAt: 1 });
    for (let i = 1; i <= events; i += 1) appendRunEvent(runId, "round", `第 ${i} 轮`, { round: i });
  }

  test("不带游标返回最新一页;按当前最小 seq 向前翻页无重复无缺口", () => {
    seedRun(CONV5, "page-run", 7);

    const latest = listRunEventPage("page-run", { limit: 3 });
    expect(latest.runId).toBe("page-run");
    expect(latest.events.map((event) => event.seq)).toEqual([5, 6, 7]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBeforeSeq).toBe(5);
    expect(latest.throughSeq).toBe(7);

    const collected: number[] = [];
    let page = latest;
    while (true) {
      collected.unshift(...page.events.map((event) => event.seq));
      if (!page.hasMore || page.nextBeforeSeq === null) break;
      page = listRunEventPage("page-run", { beforeSeq: page.nextBeforeSeq, limit: 3 });
    }
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("beforeSeq 严格小于;到底返回空页;非法游标不回落成最新页", () => {
    seedRun(CONV5, "page-edge", 3);

    expect(listRunEventPage("page-edge", { beforeSeq: 3 }).events.map((event) => event.seq)).toEqual([1, 2]);
    expect(listRunEventPage("page-edge", { beforeSeq: 4 }).events.map((event) => event.seq)).toEqual([1, 2, 3]);

    expect(listRunEventPage("page-edge", { beforeSeq: 1 })).toEqual({
      runId: "page-edge",
      events: [],
      hasMore: false,
      nextBeforeSeq: null,
      throughSeq: null,
    });
    for (const bad of [0, -5, Number.NaN, 2.5]) {
      expect(listRunEventPage("page-edge", { beforeSeq: bad }).events).toEqual([]);
    }
  });

  test("limit 归一:非法回默认 200,超过上限钳到 300", () => {
    expect(normalizeEventPageLimit(null)).toBe(200);
    expect(normalizeEventPageLimit(undefined)).toBe(200);
    expect(normalizeEventPageLimit("abc")).toBe(200);
    expect(normalizeEventPageLimit("0")).toBe(200);
    expect(normalizeEventPageLimit("-3")).toBe(200);
    expect(normalizeEventPageLimit(NaN)).toBe(200);
    expect(normalizeEventPageLimit("2.5")).toBe(2);
    expect(normalizeEventPageLimit("300")).toBe(300);
    expect(normalizeEventPageLimit("9999")).toBe(300);
  });

  test("跨会话读取按归属返回 null(路由据此 404)", () => {
    seedRun(CONV5, "owned-run", 1);
    expect(getRunForConversation(CONV, "owned-run")).toBeNull();
    expect(getRunForConversation(CONV5, "owned-run")!.id).toBe("owned-run");
    expect(getRunForConversation(CONV5, "ghost-run")).toBeNull();
  });
});

describe("快照窗口(O1)", () => {
  test("长运行刷新取最新一页,末尾事件不再消失;旧字段形状不变", () => {
    insertRun({ id: "snap-run", conversationId: CONV3, nodeId: null, engine: "chat", startedAt: 9_000 });
    for (let i = 1; i <= 205; i += 1) appendRunEvent("snap-run", "round", `第 ${i} 轮`, { round: i });
    const snapshot = getRunSnapshot(CONV3);
    expect(snapshot.run!.id).toBe("snap-run");
    expect(snapshot.events).toHaveLength(200);
    expect(snapshot.events[0]!.seq).toBe(6);
    expect(snapshot.events[199]!.seq).toBe(205);
    expect(snapshot.hasMore).toBe(true);
    expect(snapshot.nextBeforeSeq).toBe(6);
    expect(snapshot.throughSeq).toBe(205);
  });

  test("无 run 的会话返回空快照(字段齐全)", () => {
    expect(getRunSnapshot(`${CONV}-empty`)).toEqual({
      run: null,
      events: [],
      hasMore: false,
      nextBeforeSeq: null,
      throughSeq: null,
    });
  });
});
