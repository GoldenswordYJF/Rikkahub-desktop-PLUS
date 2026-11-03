// tests/agent-run-audit.test.tsx — 生命周期 L4:审计面板的纯函数契约
//
// 钉住:查询串只带有效筛选与游标、时间跨度文案、导出文件名不含目标原文。
import { describe, expect, test } from "bun:test";

import {
  auditExportFilename,
  buildAuditQuery,
  formatRunSpan,
} from "~/components/settings/experiments/agent-bot-audit";
import type { AgentRunSummary } from "~/types";

function run(overrides: Partial<AgentRunSummary> = {}): AgentRunSummary {
  return {
    id: "run-abcdef123456",
    conversationId: "conv-987654321",
    nodeId: null,
    engine: "chat",
    status: "succeeded",
    phase: "acting",
    stopReason: null,
    rounds: 3,
    attempts: 0,
    replanCount: 0,
    stallReason: null,
    goal: "机密目标不该出现在文件名里",
    resumedFromRunId: null,
    scheduleId: null,
    startedAt: new Date(2026, 10, 3, 10, 0, 0).getTime(),
    endedAt: new Date(2026, 10, 3, 10, 5, 0).getTime(),
    error: null,
    ...overrides,
  } as AgentRunSummary;
}

describe("审计查询串", () => {
  test("空筛选不产生参数;有效筛选与游标按名拼装", () => {
    expect(buildAuditQuery({ status: "", engine: "  ", conversationId: "", scheduleId: "" })).toBe("");
    const query = buildAuditQuery({
      status: "stopped",
      engine: " pi ",
      conversationId: "conv-1",
      scheduleId: "sched-2",
      beforeStartedAt: 1000,
      beforeId: "run-9",
      limit: 50,
    });
    const params = new URLSearchParams(query);
    expect(params.get("status")).toBe("stopped");
    expect(params.get("engine")).toBe("pi");
    expect(params.get("conversationId")).toBe("conv-1");
    expect(params.get("scheduleId")).toBe("sched-2");
    expect(params.get("beforeStartedAt")).toBe("1000");
    expect(params.get("beforeId")).toBe("run-9");
    expect(params.get("limit")).toBe("50");
  });
});

describe("时间跨度与导出文件名", () => {
  test("运行中只给起点;已结束给区间", () => {
    const running = formatRunSpan(run({ endedAt: null }), "zh-CN");
    expect(running).toContain("→");
    expect(running.endsWith("→")).toBe(true);
    const done = formatRunSpan(run(), "zh-CN");
    expect(done.split("→")).toHaveLength(2);
  });

  test("文件名只含短 id 与日期,不含目标/会话标题原文", () => {
    const name = auditExportFilename("conv-987654321", "run-abcdef123456");
    expect(name).toMatch(/^conv-conv-987-run-run-abcd-\d{4}-\d{2}-\d{2}\.ndjson$/);
    expect(name).not.toContain("机密");
  });
});
