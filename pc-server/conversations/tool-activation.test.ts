// conversations/tool-activation.test.ts — S9 会话级工具激活集回归
// 覆盖:宽容归一(pending 与 active 互斥/去重/截断)、登记→提升时序、写读往返、
// 老库/缺行/损坏 JSON 的降级(永不抛错);S11:按实时池清理失效 active/pending。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureConversationTables } from "./index";
import {
  normalizeToolActivation,
  promotePendingToolActivationIn,
  pruneToolActivationIn,
  readToolActivationFrom,
  registerPendingToolActivationIn,
  TOOL_ACTIVATION_MAX_PENDING,
  writeToolActivationInto,
} from "./tool-activation";

function fixtureDb(conversationId = "c1"): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  ensureConversationTables(db);
  db.prepare(
    "INSERT INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, 'a1', '', '', '[]', 0, 1, 1)",
  ).run(conversationId);
  return db;
}

describe("normalizeToolActivation", () => {
  test("非对象/损坏输入回落空集", () => {
    expect(normalizeToolActivation(null)).toEqual({ active: [], pending: [] });
    expect(normalizeToolActivation("x")).toEqual({ active: [], pending: [] });
    expect(normalizeToolActivation({ active: "x", pending: 1 })).toEqual({ active: [], pending: [] });
  });

  test("去重/去空白/非字符串过滤;active 优先,pending 不重复", () => {
    expect(normalizeToolActivation({
      active: [" mcp__a ", "mcp__a", 3, "", "mcp__b"],
      pending: ["mcp__b", "mcp__c", "mcp__c"],
    })).toEqual({ active: ["mcp__a", "mcp__b"], pending: ["mcp__c"] });
  });

  test("pending 上限截断", () => {
    const pending = Array.from({ length: TOOL_ACTIVATION_MAX_PENDING + 5 }, (_, index) => `mcp__t${index}`);
    expect(normalizeToolActivation({ active: [], pending }).pending).toHaveLength(TOOL_ACTIVATION_MAX_PENDING);
  });
});

describe("登记与轮边界提升", () => {
  test("登记只写 pending;提升后 active 可见、pending 清空;重复提升为空", () => {
    const db = fixtureDb();
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: [], pending: [] });

    expect(registerPendingToolActivationIn(db, "c1", ["mcp__a", "mcp__b"])).toEqual(["mcp__a", "mcp__b"]);
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: [], pending: ["mcp__a", "mcp__b"] });
    // 重复登记不重复入队
    expect(registerPendingToolActivationIn(db, "c1", ["mcp__b", "mcp__c"])).toEqual(["mcp__c"]);

    expect(promotePendingToolActivationIn(db, "c1")).toEqual(["mcp__a", "mcp__b", "mcp__c"]);
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: ["mcp__a", "mcp__b", "mcp__c"], pending: [] });
    expect(promotePendingToolActivationIn(db, "c1")).toEqual([]);

    // 已激活的工具再被登记时直接忽略
    expect(registerPendingToolActivationIn(db, "c1", ["mcp__a"])).toEqual([]);
  });

  test("写读往返;缺行/损坏 JSON 降级为空集且不抛", () => {
    const db = fixtureDb();
    writeToolActivationInto(db, "c1", { active: ["mcp__a"], pending: ["mcp__b"] });
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: ["mcp__a"], pending: ["mcp__b"] });

    db.prepare("UPDATE pc_conversation SET tool_activation = ? WHERE id = 'c1'").run("{not json");
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: [], pending: [] });

    expect(readToolActivationFrom(db, "missing")).toEqual({ active: [], pending: [] });
    expect(() => writeToolActivationInto(db, "missing", { active: ["x"], pending: [] })).not.toThrow();
  });
});

describe("S11 失效清理(prune)", () => {
  test("按实时池清理 active/pending,返回移除名单;无变化返回空且不改写", () => {
    const db = fixtureDb();
    writeToolActivationInto(db, "c1", {
      active: ["mcp__a", "mcp__gone"],
      pending: ["mcp__b", "mcp__gone2"],
    });
    expect(pruneToolActivationIn(db, "c1", new Set(["mcp__a", "mcp__b"])))
      .toEqual(["mcp__gone", "mcp__gone2"]);
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: ["mcp__a"], pending: ["mcp__b"] });
    // 池再次缩小时只有消失的名字被移除;全部可见时不写库/不回名单。
    expect(pruneToolActivationIn(db, "c1", ["mcp__a", "mcp__b"])).toEqual([]);
    expect(pruneToolActivationIn(db, "c1", ["mcp__a"])).toEqual(["mcp__b"]);
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: ["mcp__a"], pending: [] });
  });

  test("池为空(服务器全被禁用/删除)清空激活集;缺行/损坏 JSON 不抛", () => {
    const db = fixtureDb();
    writeToolActivationInto(db, "c1", { active: ["mcp__a"], pending: ["mcp__b"] });
    expect(pruneToolActivationIn(db, "c1", [])).toEqual(["mcp__a", "mcp__b"]);
    expect(readToolActivationFrom(db, "c1")).toEqual({ active: [], pending: [] });

    db.prepare("UPDATE pc_conversation SET tool_activation = ? WHERE id = 'c1'").run("{broken");
    expect(pruneToolActivationIn(db, "c1", [])).toEqual([]);
    expect(pruneToolActivationIn(db, "missing", [])).toEqual([]);
  });
});
