// agent-loop/controller.ts — 自主循环判定表(S3,全部确定性规则)
//
// 定位:轮边界上的纯判定器。它只看三样东西:
//   1) 本轮执行过的工具(名字、规范化参数、输出文本、错误签名);
//   2) 会话消息流里的最新计划(由调用方 readPlan 现读,本模块零 I/O);
//   3) 自己的计数器(连续重复/连续同错/replan 次数/上次校验进度)。
// 判定结果只有三种:继续、注入一条模型面提示、终局(halt)。
//
// 三条所有权纪律(plan §3.1):
//   - 判定不由模型自评:停滞、replan 上限、完成校验全部由这里数出来;
//   - 模型改不了目标:goal/done_when/boundaries 的锁定在 plan.ts(合并层),这里只读;
//   - 终局不静默:halt 带明确 reason,由协调器落运行记录并交给人("继续 / 改目标")。
//
// 规则表(plan §3.3):3 连续重复同参同输出 → 提示换路径,达上限 stalled;
// 4 同一错误签名连续出现 → replan(注入),达上限/无进展 → awaiting_user;
// 1/2 最终轮计划未了结或缺证据 → 注入重采样一次,仍无进展 → stalled。

import type { JsonValue, ToolOutputEntry } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import type { LoopDecision, LoopToolObservation } from "../inference-engine/events";
import { isPlanV2, type Plan, type PlanStep } from "../tools/plan";

export interface AgentLoopControllerConfig {
  maxReplans: number;
  stallRepeatLimit: number;
  sameErrorLimit: number;
  requireVerifiedCompletion: boolean;
}

/** 计划读取/记账回调。判定器保持零 I/O:计划由调用方现读,事件由调用方落库。 */
export interface AgentLoopControllerDeps {
  readPlan: () => Plan | null;
  /** replan 即将注入时调用(运行记录:replan 计数 + 事件)。 */
  onReplan?: (info: {
    reason: string;
    toolName: string;
    errorSignature: string | null;
    replanCount: number;
    settled: number;
  }) => void;
  /** 判定为停滞时调用(运行记录:stall 事件 + 相位)。 */
  onStall?: (info: {
    reason: string;
    kind: "repeat" | "same_error" | "unsettled";
  }) => void;
  /** 计划里出现目标时回调(运行记录回填 goal 快照)。 */
  onGoal?: (goal: string) => void;
}

/** 完成校验口径:未了结 = pending/in_progress;未验证 = completed 但无证据。 */
export interface PlanVerification {
  ok: boolean;
  pending: string[];
  unverified: string[];
  /** 通过校验的已了结步骤数(replan 无进展判定的进度基线)。 */
  settled: number;
}

function stepLabel(step: PlanStep, index: number): string {
  return step.id ?? `s${index + 1}`;
}

/** 完成校验(plan §3.5)。requireVerified=false 时 completed 一律算通过(兼容旧计划语义)。 */
export function verifyPlanCompletion(plan: Plan, requireVerified: boolean): PlanVerification {
  const pending: string[] = [];
  const unverified: string[] = [];
  let settled = 0;
  plan.steps.forEach((step, index) => {
    if (step.status === "cancelled") {
      settled += 1;
      return;
    }
    if (step.status === "completed") {
      if (requireVerified && (step.evidence?.length ?? 0) === 0) unverified.push(stepLabel(step, index));
      else settled += 1;
      return;
    }
    pending.push(stepLabel(step, index));
  });
  return { ok: pending.length === 0 && unverified.length === 0, pending, unverified, settled };
}

/** JSON 参数规范化:解析后按 key 排序重新序列化(纯比较用途,不做语义改写)。
 *  非法 JSON 退化为去空白原文——同一畸形参数仍能识别为"同一调用"。 */
export function normalizeToolArguments(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return text.replace(/\s+/g, " ");
  }
  return stableStringify(parsed);
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 输出签名:折叠空白后取 FNV-1a。只用于"输出无新增信息"比较,不进任何展示面。 */
export function outputSignature(text: string): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length}:${hash.toString(16)}`;
}

/** 错误签名:工具名 + 归一化错误文本。去掉会漂移的 id/数字/十六进制,让同一种失败可归并。 */
export function errorSignatureOf(toolName: string, errorText: string): string {
  const normalized = String(errorText ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return `${toolName}:${normalized}`;
}

function textFromOutputEntry(entry: unknown): string {
  if (!isRecord(entry)) return typeof entry === "string" ? entry : "";
  if (typeof entry.error === "string") return entry.error;
  if (entry.type === "text" && typeof entry.text === "string") return entry.text;
  if (entry.type === "image" && typeof entry.url === "string") return entry.url;
  if (entry.type === "document" && typeof entry.url === "string") return entry.url;
  return "";
}

/** 从工具执行结果构造观察项(聊天引擎工具循环骨架用)。 */
export function buildToolObservation(
  call: { id: string; name: string; arguments: string },
  output: ToolOutputEntry[],
): LoopToolObservation {
  const outputText = output.map(textFromOutputEntry).filter(Boolean).join("\n");
  const errorText = output
    .map((entry) => {
      // ToolErrorOutput 是历史契约的裸 {error}(不在 MessagePart 联合里),这里按形状读。
      const error = (entry as { error?: unknown } | null)?.error;
      return typeof error === "string" ? error : "";
    })
    .filter(Boolean)
    .join("\n");
  return {
    toolCallId: call.id,
    toolName: call.name,
    arguments: call.arguments,
    outputText,
    errorSignature: errorText ? errorSignatureOf(call.name, errorText) : null,
  };
}

function truncate(text: string, max: number): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const CONTINUE: LoopDecision = { action: "continue" };

export class AgentLoopController {
  private readonly config: AgentLoopControllerConfig;
  private readonly deps: AgentLoopControllerDeps;

  // 连续重复:同 (工具名, 规范化参数) 且输出签名不变。
  private repeatKey: string | null = null;
  private repeatOutput: string | null = null;
  private repeatCount = 0;
  private repeatHintedKey: string | null = null;

  // 连续同错。
  private errorSignature: string | null = null;
  private errorCount = 0;

  // replan 记账。
  private replanCount = 0;
  private settledAtLastReplan: number | null = null;
  private stagnantReplans = 0;

  // 最终轮校验:同一份未了结指纹只重采样一次。
  private verifyInjections = 0;
  private verifyFingerprint: string | null = null;

  constructor(config: AgentLoopControllerConfig, deps: AgentLoopControllerDeps) {
    this.config = {
      maxReplans: Math.max(0, Math.floor(config.maxReplans)),
      stallRepeatLimit: Math.max(2, Math.floor(config.stallRepeatLimit)),
      sameErrorLimit: Math.max(2, Math.floor(config.sameErrorLimit)),
      requireVerifiedCompletion: config.requireVerifiedCompletion,
    };
    this.deps = deps;
  }

  get replans(): number {
    return this.replanCount;
  }

  /** 一次工具批执行完(下一次模型请求前)。 */
  evaluateToolRound(observations: LoopToolObservation[]): LoopDecision {
    const plan = this.deps.readPlan();
    if (plan?.goal) this.deps.onGoal?.(plan.goal);
    const settled = plan ? verifyPlanCompletion(plan, this.config.requireVerifiedCompletion).settled : 0;

    let repeatLimitHit: { toolName: string } | null = null;
    let repeatHint: { toolName: string } | null = null;
    let errorLimitHit: { toolName: string; errorSignature: string; errorText: string } | null = null;

    for (const obs of observations) {
      const key = `${obs.toolName}|${normalizeToolArguments(obs.arguments)}`;
      const output = outputSignature(obs.outputText);

      // 规则 3:同参同输出才算"原地打转";参数变(分页/翻页)或输出变(新信息)都重置。
      if (key === this.repeatKey && output === this.repeatOutput) {
        this.repeatCount += 1;
        if (this.repeatCount >= this.config.stallRepeatLimit) {
          repeatLimitHit = { toolName: obs.toolName };
        } else if (this.repeatCount >= this.config.stallRepeatLimit - 1 && this.repeatHintedKey !== key) {
          repeatHint = { toolName: obs.toolName };
        }
      } else {
        this.repeatKey = key;
        this.repeatOutput = output;
        this.repeatCount = 1;
      }

      // 规则 4:同一错误签名连续出现。成功的一次执行会打断"连续"链。
      if (obs.errorSignature) {
        if (obs.errorSignature === this.errorSignature) {
          this.errorCount += 1;
        } else {
          this.errorSignature = obs.errorSignature;
          this.errorCount = 1;
        }
        if (this.errorCount >= this.config.sameErrorLimit) {
          errorLimitHit = {
            toolName: obs.toolName,
            errorSignature: obs.errorSignature,
            errorText: obs.outputText,
          };
        }
      } else {
        this.errorSignature = null;
        this.errorCount = 0;
      }
    }

    // 停滞优先于 replan:连参数都没换,再让模型改步骤也是白改。
    if (repeatLimitHit) {
      const reason = `同一工具以相同参数连续调用 ${this.repeatCount} 次且输出无变化(${repeatLimitHit.toolName})`;
      this.deps.onStall?.({ reason, kind: "repeat" });
      return { action: "halt", status: "stalled", reason };
    }

    if (errorLimitHit) {
      // 无进展 = 上次 replan 时的已了结步骤数没有增长。允许最多 maxReplans 次 replan;
      // 连续两次 replan 都无进展才认为 replan 这条通道失效,转 awaiting_user。
      const noProgress = this.settledAtLastReplan !== null && settled <= this.settledAtLastReplan;
      const exhausted =
        this.replanCount >= this.config.maxReplans || (noProgress && this.stagnantReplans >= 1);
      if (exhausted) {
        const reason = `同一错误连续出现 ${this.errorCount} 次,已重规划 ${this.replanCount} 次仍无进展`;
        this.deps.onStall?.({ reason, kind: "same_error" });
        return { action: "halt", status: "awaiting_user", reason };
      }
      this.replanCount += 1;
      if (noProgress) this.stagnantReplans += 1;
      else this.stagnantReplans = 0;
      this.settledAtLastReplan = settled;
      this.errorCount = 0;
      this.errorSignature = null;
      const reason = `同一错误连续出现 ${this.config.sameErrorLimit} 次(${errorLimitHit.toolName})`;
      this.deps.onReplan?.({
        reason,
        toolName: errorLimitHit.toolName,
        errorSignature: errorLimitHit.errorSignature,
        replanCount: this.replanCount,
        settled,
      });
      return {
        action: "inject",
        text:
          `Replan required: the same error has repeated ${this.config.sameErrorLimit} times in a row ` +
          `(${errorLimitHit.toolName}: ${truncate(errorLimitHit.errorText, 200)}). ` +
          `Revise your plan steps or change your approach, then continue. ` +
          `Do not repeat the same tool call with the same arguments. ` +
          `If the task truly cannot be completed, say so explicitly instead of retrying.`,
      };
    }

    if (repeatHint) {
      this.repeatHintedKey = this.repeatKey;
      return {
        action: "inject",
        text:
          `You are repeating the same ${repeatHint.toolName} call with identical arguments and the output has not changed. ` +
          `Change approach or arguments; if the information is already available, use it and move on to the next step.`,
      };
    }

    return CONTINUE;
  }

  /** 模型本轮没有调用工具、即将收尾时。完成校验通过才允许 succeeded(plan §3.5)。 */
  evaluateFinal(): LoopDecision {
    const plan = this.deps.readPlan();
    if (plan?.goal) this.deps.onGoal?.(plan.goal);
    // 无计划 / 旧形状计划:自主循环不据此拦截(旧会话打开总开关也不能被卡死)。
    if (!plan || !isPlanV2(plan) || plan.steps.length === 0) return CONTINUE;

    const verification = verifyPlanCompletion(plan, this.config.requireVerifiedCompletion);
    if (verification.ok) {
      this.verifyInjections = 0;
      this.verifyFingerprint = null;
      return CONTINUE;
    }

    const fingerprint = `${verification.pending.join(",")}|${verification.unverified.join(",")}`;
    if (this.verifyInjections > 0 && this.verifyFingerprint === fingerprint) {
      const reason = `计划仍未了结(${fingerprint.replace("|", " / ")}),重采样后无进展`;
      this.deps.onStall?.({ reason, kind: "unsettled" });
      return { action: "halt", status: "stalled", reason };
    }
    this.verifyInjections += 1;
    this.verifyFingerprint = fingerprint;

    const parts: string[] = [`Do not finish yet: the plan "${plan.title || "current plan"}" is not complete.`];
    if (verification.pending.length) {
      parts.push(`Unfinished steps: ${verification.pending.join(", ")}.`);
    }
    if (verification.unverified.length) {
      parts.push(
        `Steps marked completed without tool evidence: ${verification.unverified.join(", ")}. ` +
          `Add the toolCallId(s) that produced them to the step's evidence, or do the work and then mark it complete.`,
      );
    }
    parts.push(
      `Continue working. Mark a step completed only when you have evidence for it, ` +
        `or cancel steps that are no longer needed. Do not claim completion without evidence.`,
    );
    return { action: "inject", text: parts.join(" ") };
  }
}
