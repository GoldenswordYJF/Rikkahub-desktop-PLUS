// 任务图计划面板徽标契约:图状态与重试预算只在 v3 计划里出现,旧 v2 不误伤。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanStepGraphBadges } from "~/components/workbench/plan-panel";
import i18n from "~/i18n";
import { planViewFromProjection } from "~/lib/plan-model";
import { normalizePlan } from "@server/tools/plan";
import { analyzePlanGraph } from "@server/tools/plan-graph";

const t = i18n.getFixedT(null, "common") as never;

function step(overrides: Record<string, unknown>) {
  return normalizePlan(
    {
      goal: "迁移",
      steps: [
        {
          id: "s1",
          content: "导出",
          status: "pending",
          max_attempts: 3,
          ...overrides,
        },
      ],
    },
    { graph: true, trusted: true },
  ).steps[0]!;
}

function render(overrides: Record<string, unknown>, analysis = null as ReturnType<typeof analyzePlanGraph> | null) {
  const item = step(overrides);
  return renderToStaticMarkup(
    React.createElement(PlanStepGraphBadges, {
      step: item,
      stepId: "s1",
      analysis,
      graph: true,
      v2: true,
      t,
    }),
  );
}

describe("计划面板 — 任务图徽标", () => {
  test("预算耗尽与重试计数同时展示", () => {
    const html = render(
      { status: "failed", attempts: 3, max_attempts: 3, last_error: "timeout" },
      { ready: [], blocked: {}, retryable: [], exhausted: ["s1"] },
    );
    expect(html).toContain(i18n.t("workbench.plan.exhausted", { ns: "common" }));
    expect(html).toContain("3/3");
  });

  test("可重试失败步骤显示预算而非终局", () => {
    const html = render(
      { status: "failed", attempts: 1, max_attempts: 3, last_error: "timeout" },
      { ready: [], blocked: {}, retryable: ["s1"], exhausted: [] },
    );
    expect(html).toContain(i18n.t("workbench.plan.retryable", { ns: "common" }));
    expect(html).toContain("1/3");
    expect(html).not.toContain(i18n.t("workbench.plan.exhausted", { ns: "common" }));
  });

  test("阻塞步骤点名未满足的直接依赖", () => {
    const html = render(
      { status: "pending", attempts: 0 },
      { ready: [], blocked: { s1: ["s0"] }, retryable: [], exhausted: [] },
    );
    expect(html).toContain("s0");
  });

  test("旧 v2 计划无图、无尝试时不渲染额外徽标", () => {
    const item = normalizePlan({
      goal: "旧计划",
      steps: [{ id: "s1", content: "老步骤", status: "pending" }],
    }).steps[0]!;
    const html = renderToStaticMarkup(
      React.createElement(PlanStepGraphBadges, {
        step: item,
        stepId: "s1",
        analysis: null,
        graph: false,
        v2: true,
        t,
      }),
    );
    expect(html).toBe("");
  });

  test("历史投影归一化保留 v3 依赖与预算", () => {
    const view = planViewFromProjection({
      runId: "r1",
      plan: {
        plan: {
          title: "图",
          goal: "迁移",
          done_when: [],
          boundaries: [],
          steps: [
            {
              id: "s1",
              content: "导出",
              status: "pending",
              verify: "",
              evidence: [],
              attempts: 0,
              last_error: null,
              depends_on: [],
              max_attempts: 2,
            },
            {
              id: "s2",
              content: "导入",
              status: "pending",
              verify: "",
              evidence: [],
              attempts: 1,
              last_error: null,
              depends_on: ["s1"],
              max_attempts: 3,
            },
          ],
        },
        sourceToolCallId: "tc",
        sourceMessageId: "m1",
        unavailableReason: null,
        v2: true,
        toolLocations: {},
      },
      boundaries: {},
    } as never);
    expect(view?.plan?.steps[1]).toMatchObject({ dependsOn: ["s1"], maxAttempts: 3, attempts: 1 });
    expect(analyzePlanGraph(view!.plan!).blocked).toEqual({ s2: ["s1"] });
  });
});
