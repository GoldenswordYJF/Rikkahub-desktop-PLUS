// tools/plan-graph.test.ts — 任务图纯函数行为锁。
//
// 钉的是三件事:非法图必须可被完整识别;就绪/阻塞只按已满足的依赖推导;
// 失败步骤按代码维护的次数区分「还能重试」与「预算耗尽」。

import { describe, expect, test } from "bun:test";

import { analyzePlanGraph, validatePlanGraph } from "./plan-graph";
import { normalizePlan, type Plan } from "./plan";

function graph(steps: unknown[], trusted = false): Plan {
  return normalizePlan({ goal: "完成迁移", steps }, { graph: true, trusted });
}

describe("validatePlanGraph — 结构性拒绝", () => {
  test("accepts a diamond DAG", () => {
    const plan = graph([
      { id: "s1", content: "导出", status: "pending" },
      { id: "s2", content: "建表", status: "pending", depends_on: ["s1"] },
      { id: "s3", content: "写脚本", status: "pending", depends_on: ["s1"] },
      { id: "s4", content: "导入", status: "pending", depends_on: ["s2", "s3"] },
    ]);
    expect(validatePlanGraph(plan)).toEqual([]);
  });

  test("rejects unknown self and cyclic dependencies", () => {
    const unknown = graph([
      { id: "s1", content: "a", status: "pending", depends_on: ["nope"] },
    ]);
    expect(validatePlanGraph(unknown).map((issue) => issue.code)).toEqual(["unknown_dependency"]);

    const self = graph([{ id: "s1", content: "a", status: "pending", depends_on: ["s1"] }]);
    expect(validatePlanGraph(self).map((issue) => issue.code)).toEqual(["self_dependency"]);

    const cycle = graph([
      { id: "s1", content: "a", status: "pending", depends_on: ["s3"] },
      { id: "s2", content: "b", status: "pending", depends_on: ["s1"] },
      { id: "s3", content: "c", status: "pending", depends_on: ["s2"] },
    ]);
    expect(validatePlanGraph(cycle).some((issue) => issue.code === "cycle")).toBe(true);
  });

  test("rejects more than eight direct dependencies", () => {
    const plan = graph([
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `r${index + 1}`,
        content: `root ${index + 1}`,
        status: "pending",
      })),
      {
        id: "join",
        content: "join",
        status: "pending",
        depends_on: Array.from({ length: 9 }, (_, index) => `r${index + 1}`),
      },
    ]);
    expect(validatePlanGraph(plan).some((issue) => issue.code === "too_many_dependencies")).toBe(true);
  });
});

describe("analyzePlanGraph — 就绪与阻塞", () => {
  test("computes ready and blocked from verified dependencies", () => {
    const empty = graph([
      { id: "s1", content: "导出", status: "pending" },
      { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
    ]);
    expect(analyzePlanGraph(empty)).toMatchObject({
      ready: ["s1"],
      blocked: { s2: ["s1"] },
    });

    const unverified = graph([
      { id: "s1", content: "导出", status: "completed" },
      { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
    ]);
    expect(analyzePlanGraph(unverified)).toMatchObject({
      ready: [],
      blocked: { s2: ["s1"] },
    });

    const verified = graph([
      { id: "s1", content: "导出", status: "completed", evidence: ["tc-1"] },
      { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
    ]);
    expect(analyzePlanGraph(verified)).toMatchObject({
      ready: ["s2"],
      blocked: {},
    });
  });

  test("treats cancelled dependencies as unsatisfied", () => {
    const plan = graph([
      { id: "s1", content: "导出", status: "cancelled" },
      { id: "s2", content: "导入", status: "pending", depends_on: ["s1"] },
    ]);
    expect(analyzePlanGraph(plan).blocked).toEqual({ s2: ["s1"] });
  });

  test("keeps only one executable step while another is in progress", () => {
    const plan = graph([
      { id: "s1", content: "导出", status: "in_progress" },
      { id: "s2", content: "建表", status: "pending" },
    ]);
    expect(analyzePlanGraph(plan)).toMatchObject({ ready: [], blocked: {} });
  });

  test("separates retryable from exhausted failures", () => {
    const retryable = graph(
      [
        { id: "s1", content: "导出", status: "failed", attempts: 1, max_attempts: 3, last_error: "timeout" },
      ],
      true,
    );
    expect(analyzePlanGraph(retryable)).toMatchObject({ retryable: ["s1"], exhausted: [] });

    const exhausted = graph(
      [
        { id: "s1", content: "导出", status: "failed", attempts: 3, max_attempts: 3, last_error: "timeout" },
      ],
      true,
    );
    expect(analyzePlanGraph(exhausted)).toMatchObject({ retryable: [], exhausted: ["s1"] });
  });
});
