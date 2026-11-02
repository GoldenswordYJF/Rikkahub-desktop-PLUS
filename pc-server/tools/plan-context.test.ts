// tools/plan-context.test.ts — 计划改写保护的前值读取(自主循环 S2)
//
// 钉住"上一版计划"的三个边界:同一 run 才参与合并、当前调用不算前值、
// 权威快照优先于模型可篡改的原始 input。
import { describe, expect, test } from "bun:test";

import type { Conversation, Message, MessageNode } from "../foundation/types";
import { findPlanContext, latestPlan } from "./plan-context";
import { PLAN_TOOL_NAME, toPlanSnapshot, type Plan } from "./plan";

function message(role: Message["role"], parts: Message["parts"]): Message {
  return {
    id: `m-${role}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    parts,
    annotations: [],
    createdAt: "2026-11-01T00:00:00",
    finishedAt: null,
    modelId: null,
    usage: null,
    translation: null,
  };
}

function node(messages: Message[], selectIndex = 0): MessageNode {
  return { id: `n-${Math.random().toString(36).slice(2, 6)}`, messages, selectIndex };
}

function conversation(messages: MessageNode[]): Conversation {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "t",
    messages,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  };
}

function planPart(toolCallId: string, input: unknown, snapshot?: unknown): Message["parts"][number] {
  return {
    type: "tool",
    toolCallId,
    toolName: PLAN_TOOL_NAME,
    input: typeof input === "string" ? input : JSON.stringify(input),
    output: snapshot
      ? [{ type: "text", text: "{}", metadata: { planV2: snapshot as never } }]
      : [],
    approvalState: { type: "auto" },
  };
}

const planInput = {
  goal: "真目标",
  done_when: ["D"],
  steps: [{ id: "s1", content: "a", status: "pending" }],
};

describe("findPlanContext", () => {
  test("没有计划:首次发布,允许设定目标", () => {
    expect(findPlanContext(conversation([node([message("USER", [])])]))).toEqual({
      previous: null,
      allowGoalChange: true,
    });
  });

  test("本轮已有计划:作为合并基线,不允许改写目标", () => {
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      ]),
    );
    expect(ctx.allowGoalChange).toBe(false);
    expect(ctx.previous?.goal).toBe("真目标");
  });

  test("计划属于上一轮用户消息之前:新 run,不作为基线", () => {
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc1", planInput)])]),
        node([message("USER", [])]),
        node([message("ASSISTANT", [])]),
      ]),
    );
    expect(ctx).toEqual({ previous: null, allowGoalChange: true });
  });

  test("当前工具调用不算自己的前值;同消息里的更早计划仍可作为基线", () => {
    const onlyCurrent = findPlanContext(
      conversation([node([message("USER", [])]), node([message("ASSISTANT", [planPart("tc-now", planInput)])])]),
      "tc-now",
    );
    expect(onlyCurrent.previous).toBeNull();

    const withEarlier = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([message("ASSISTANT", [planPart("tc-old", planInput), planPart("tc-now", { steps: [] })])]),
      ]),
      "tc-now",
    );
    expect(withEarlier.previous?.goal).toBe("真目标");
  });

  test("权威快照优先:原始 input 被篡改也不污染合并基线", () => {
    const trusted: Plan = {
      title: "",
      goal: "真目标",
      doneWhen: ["D"],
      boundaries: [],
      steps: [
        { id: "s1", content: "a", status: "pending", verify: "", evidence: [], attempts: 2, lastError: null },
      ],
    };
    const ctx = findPlanContext(
      conversation([
        node([message("USER", [])]),
        node([
          message("ASSISTANT", [
            planPart("tc1", { ...planInput, goal: "篡改目标" }, toPlanSnapshot(trusted)),
          ]),
        ]),
      ]),
    );
    expect(ctx.previous?.goal).toBe("真目标");
    expect(ctx.previous?.steps[0].attempts).toBe(2);
  });

  test("畸形 input 跳过,不抛错", () => {
    const ctx = findPlanContext(
      conversation([node([message("USER", [])]), node([message("ASSISTANT", [planPart("tc1", "{oops")])])]),
    );
    expect(ctx.previous).toBeNull();
    expect(ctx.allowGoalChange).toBe(true);
  });
});

describe("latestPlan(完成校验的当前 run 计划)", () => {
  const runPlan = () =>
    conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
    ]);

  test("本轮已发布计划:返回该计划;无计划返回 null", () => {
    expect(latestPlan(runPlan())?.goal).toBe("真目标");
    expect(latestPlan(conversation([node([message("USER", [])])]))).toBeNull();
    expect(latestPlan(null)).toBeNull();
  });

  test("用户重新发言开启新 run:旧计划不再参与完成校验(等模型重新发布)", () => {
    const conv = runPlan();
    conv.messages.push(node([message("USER", [])]));
    expect(latestPlan(conv)).toBeNull();
    conv.messages.push(node([message("ASSISTANT", [planPart("tc2", { ...planInput, goal: "新目标" })])]));
    expect(latestPlan(conv)?.goal).toBe("新目标");
  });

  test("steer 补发不算新 run:带 steered 注解的用户消息之后,计划继续有效", () => {
    const steeredUser = message("USER", []);
    steeredUser.annotations.push({ type: "steered" });
    const conv = conversation([
      node([message("USER", [])]),
      node([message("ASSISTANT", [planPart("tc1", planInput)])]),
      node([steeredUser]),
      node([message("ASSISTANT", [])]),
    ]);
    expect(latestPlan(conv)?.goal).toBe("真目标");
  });
});
