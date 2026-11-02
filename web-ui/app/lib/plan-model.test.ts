// 计划读取侧的行为锁:面板永远显示「当前选中分支里最后一条完整计划」。
//
// 之所以单独立一个文件:存储是消息流本身,没有第二处真相——一旦这里的扫描方向、分支口径
// 或"半截 JSON 怎么办"漂了,面板就会显示一份模型早已作废的计划,而这类错只在真实流式里露头。
import { describe, expect, test } from "bun:test";

import { getLatestPlan, getLatestPlanEntry, planViewFromProjection } from "./plan-model";
import type { ConversationDto, RunProjectionDto } from "~/types";

/** 造一份只填了面板会读的字段的 DTO 快照(其余字段对本读取侧无意义)。 */
function dto(nodes: { messages: Record<string, unknown>[]; selectIndex?: number }[]): ConversationDto {
  return {
    messages: nodes.map((node) => ({
      selectIndex: node.selectIndex ?? 0,
      messages: node.messages,
    })),
  } as unknown as ConversationDto;
}

function planPart(input: unknown, extra: Record<string, unknown> = {}) {
  return { type: "tool", toolName: "update_plan", input: JSON.stringify(input), ...extra };
}

const V1 = { title: "第一版", steps: [{ content: "查资料", status: "completed" }] };
const V2 = {
  title: "第二版",
  steps: [{ content: "写报告", status: "in_progress" }],
};

describe("getLatestPlan", () => {
  test("没有会话 / 没有节点 → null", () => {
    expect(getLatestPlan(null)).toBeNull();
    expect(getLatestPlan(undefined)).toBeNull();
    expect(getLatestPlan({} as ConversationDto)).toBeNull();
    expect(getLatestPlan(dto([]))).toBeNull();
  });

  test("倒序取最后一条:后面的节点覆盖前面的版本", () => {
    const detail = dto([
      { messages: [{ role: "ASSISTANT", parts: [planPart(V1)] }] },
      { messages: [{ role: "ASSISTANT", parts: [planPart(V2)] }] },
    ]);
    expect(getLatestPlan(detail)?.title).toBe("第二版");
  });

  test("同一节点内也倒序:一条消息里连发两版计划取后者", () => {
    const detail = dto([{ messages: [{ parts: [planPart(V1), planPart(V2)] }] }]);
    expect(getLatestPlan(detail)?.title).toBe("第二版");
  });

  test("流式半截 JSON 不当计划,继续往更早的完整计划找", () => {
    const detail = dto([
      { messages: [{ parts: [planPart(V1)] }] },
      {
        messages: [
          {
            parts: [
              { type: "tool", toolName: "update_plan", input: '{"title": "断在', },
            ],
          },
        ],
      },
    ]);
    expect(getLatestPlan(detail)?.title).toBe("第一版");
  });

  test("steps 为空的调用(模型清计划)不占位,回落到上一份有内容的", () => {
    const detail = dto([
      { messages: [{ parts: [planPart(V2)] }] },
      { messages: [{ parts: [planPart({ title: "空清单", steps: [] })] }] },
    ]);
    expect(getLatestPlan(detail)?.title).toBe("第二版");
  });

  test("只看 update_plan:其他工具与文本 part 不参与", () => {
    const detail = dto([
      {
        messages: [
          {
            parts: [
              { type: "text", text: "先列个计划" },
              { type: "tool", toolName: "search_web", input: JSON.stringify(V2) },
            ],
          },
        ],
      },
    ]);
    expect(getLatestPlan(detail)).toBeNull();
  });

  test("优先读服务端权威快照(计划 v2):被拒绝的篡改 goal 不显示,attempts 保留", () => {
    const snapshot = {
      title: "第二版",
      goal: "真目标",
      done_when: ["D"],
      boundaries: [],
      steps: [
        { id: "s1", content: "写报告", status: "completed", verify: "", evidence: [], attempts: 2, last_error: null },
      ],
    };
    const detail = dto([
      {
        messages: [
          {
            parts: [
              planPart(
                { title: "第二版", goal: "篡改目标", steps: [{ id: "s1", content: "写报告", status: "completed" }] },
                { output: [{ type: "text", text: "{}", metadata: { planV2: snapshot } }] },
              ),
            ],
          },
        ],
      },
    ]);
    const plan = getLatestPlan(detail);
    expect(plan?.goal).toBe("真目标");
    expect(plan?.steps[0].attempts).toBe(2);
  });

  test("旧数据没有快照:回退原始 input,形状与引入前一致", () => {
    const detail = dto([{ messages: [{ parts: [planPart(V1)] }] }]);
    const plan = getLatestPlan(detail);
    expect(plan).toEqual({
      title: "第一版",
      steps: [{ content: "查资料", status: "completed" }],
    });
  });

  test("分支切换跟着 selectIndex 走:未选中分支的计划不算当前计划", () => {
    const detail = dto([
      {
        selectIndex: 1,
        messages: [
          { parts: [planPart(V1)] }, // 旧分支
          { parts: [planPart(V2)] }, // 当前选中
        ],
      },
    ]);
    expect(getLatestPlan(detail)?.title).toBe("第二版");
    // selectIndex 越界时回落到第一条,而不是抛错或读到 undefined
    expect(getLatestPlan(dto([{ selectIndex: 9, messages: [{ parts: [planPart(V1)] }] }]))?.title).toBe(
      "第一版",
    );
  });
});

describe("getLatestPlanEntry", () => {
  test("带出来源 toolCallId / messageId,供来源角标与工具卡定位", () => {
    const detail = dto([
      {
        messages: [
          {
            id: "msg-1",
            parts: [planPart(V2, { toolCallId: "tc-plan" })],
          },
        ],
      },
    ]);
    // dto 只保留节点,这里手动补 node/message id
    (detail.messages[0] as unknown as { id: string }).id = "node-1";
    const entry = getLatestPlanEntry(detail)!;
    expect(entry.toolCallId).toBe("tc-plan");
    expect(entry.messageId).toBe("msg-1");
    expect(entry.nodeId).toBe("node-1");
    expect(entry.plan.title).toBe("第二版");
  });

  test("没有 update_plan 时返回 null,不拿空计划占位", () => {
    expect(getLatestPlanEntry(dto([{ messages: [{ parts: [planPart({ title: "空", steps: [] })] }] }]))).toBeNull();
  });
});

describe("planViewFromProjection", () => {
  function projection(overrides: Partial<RunProjectionDto["plan"]> = {}): RunProjectionDto {
    return {
      runId: "run-1",
      plan: {
        plan: {
          title: "历史计划",
          goal: "目标",
          done_when: ["D"],
          boundaries: [],
          steps: [
            {
              id: "s1",
              content: "写报告",
              status: "completed",
              verify: "bun test",
              evidence: ["tc-1"],
              attempts: 2,
              last_error: "timeout",
            },
          ],
        },
        sourceToolCallId: "tc-plan",
        sourceMessageId: "msg-1",
        unavailableReason: null,
        v2: true,
        toolLocations: { "tc-1": { messageId: "msg-1", visible: true } },
        ...overrides,
      },
    };
  }

  test("null 投影保持 null,调用方继续显示加载态", () => {
    expect(planViewFromProjection(null)).toBeNull();
  });

  test("映射 v2 计划、来源与 toolLocations;未验证语义不丢 attempting 信息", () => {
    const view = planViewFromProjection(projection())!;
    expect(view.plan?.title).toBe("历史计划");
    expect(view.v2).toBe(true);
    expect(view.sourceToolCallId).toBe("tc-plan");
    expect(view.sourceMessageId).toBe("msg-1");
    expect(view.unavailableReason).toBeNull();
    expect(view.toolLocations["tc-1"]).toEqual({ messageId: "msg-1", visible: true });
    expect(view.plan?.steps[0]).toMatchObject({
      id: "s1",
      verify: "bun test",
      attempts: 2,
      lastError: "timeout",
    });
  });

  test("不可用原因原样透出,plan=null 时不伪造计划", () => {
    const view = planViewFromProjection(
      projection({ plan: null, unavailableReason: "source_missing", sourceToolCallId: "tc-gone" }),
    )!;
    expect(view.plan).toBeNull();
    expect(view.unavailableReason).toBe("source_missing");
    expect(view.sourceToolCallId).toBe("tc-gone");
  });

  test("旧计划 v2=false,不进入 evidence/未验证样式", () => {
    const oldPlan = {
      title: "旧",
      steps: [{ content: "旧步骤", status: "completed" }],
    } as unknown as NonNullable<RunProjectionDto["plan"]["plan"]>;
    const view = planViewFromProjection(projection({ plan: oldPlan, v2: false }))!;
    expect(view.v2).toBe(false);
  });
});
