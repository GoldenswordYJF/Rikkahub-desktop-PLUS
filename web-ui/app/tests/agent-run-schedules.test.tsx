// tests/agent-run-schedules.test.tsx — 生命周期 L3:定时任务面板的纯函数契约
//
// 钉住:摘要格式(启用/停用、once/间隔、下次/上次)、草稿→请求体(空目标与非法时间
// 在客户端就拦下)、interval 秒换算。组件渲染太重,这里只测可测的纯逻辑。
import { describe, expect, test } from "bun:test";

import i18n from "~/i18n";
import {
  formatScheduleSummary,
  scheduleDraftToBody,
  type TaskScheduleDto,
} from "~/components/workspace/agent-run-schedules";

const t = i18n.getFixedT("zh-CN", "page");
const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();

function schedule(overrides: Partial<TaskScheduleDto> = {}): TaskScheduleDto {
  return {
    id: "s1",
    conversationId: "c1",
    goal: "巡检",
    kind: "fixed_interval",
    runAt: null,
    intervalSeconds: 3600,
    nextRunAt: NOW + 3_600_000,
    enabled: true,
    misfirePolicy: "catch_up_once",
    lastRunAt: null,
    lastRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("定时任务摘要", () => {
  test("间隔任务:启用 + 每 N 分钟 + 下次时间", () => {
    const text = formatScheduleSummary(schedule(), NOW, t);
    expect(text).toContain("已启用");
    expect(text).toContain("每 60 分钟");
    expect(text).toContain("下次");
  });

  test("一次性任务:显示定时时刻;停用不显示下次;上次运行有则显示", () => {
    const once = formatScheduleSummary(
      schedule({ kind: "once", runAt: NOW + 60_000, nextRunAt: NOW + 60_000, intervalSeconds: null }),
      NOW,
      t,
    );
    expect(once).toContain("定时");

    const disabled = formatScheduleSummary(schedule({ enabled: false }), NOW, t);
    expect(disabled).toContain("已停用");
    expect(disabled).not.toContain("下次");

    const ran = formatScheduleSummary(schedule({ lastRunAt: NOW - 60_000 }), NOW, t);
    expect(ran).toContain("上次");
  });
});

describe("创建草稿 → 请求体", () => {
  test("空目标/无时间被客户端拦下", () => {
    expect(scheduleDraftToBody({ goal: "   ", kind: "fixed_interval", minutes: 30, runAtLocal: "" })).toEqual({
      ok: false,
      error: "goal",
    });
    expect(scheduleDraftToBody({ goal: "x", kind: "once", minutes: 30, runAtLocal: "" })).toEqual({
      ok: false,
      error: "time",
    });
    expect(scheduleDraftToBody({ goal: "x", kind: "fixed_interval", minutes: 0, runAtLocal: "" })).toEqual({
      ok: false,
      error: "time",
    });
  });

  test("间隔任务换算为秒并带默认补跑策略;一次性给毫秒时间戳", () => {
    const interval = scheduleDraftToBody({
      goal: "  巡检  ",
      kind: "fixed_interval",
      minutes: 90,
      runAtLocal: "",
    });
    expect(interval).toEqual({
      ok: true,
      body: { goal: "巡检", kind: "fixed_interval", intervalSeconds: 5400, misfirePolicy: "catch_up_once" },
    });

    const once = scheduleDraftToBody({
      goal: "提醒",
      kind: "once",
      minutes: 0,
      runAtLocal: "2026-11-04T09:30",
    });
    expect(once.ok).toBe(true);
    if (once.ok) {
      expect(once.body.kind).toBe("once");
      expect(typeof once.body.runAt).toBe("number");
      expect(once.body.runAt as number).toBe(new Date("2026-11-04T09:30").getTime());
    }
  });
});
