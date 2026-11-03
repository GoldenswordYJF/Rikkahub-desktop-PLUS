// tools/plan-graph.ts — 任务图 v3 的零 I/O 内核。
//
// 只做两件事:回答「这张图合法吗」与「现在哪些步骤可执行」。
// 不修改计划、不读写消息流、不调用工具;控制器与前端读同一份结果,避免两套规则漂移。
//
// 口径:
// - ready      pending 且直接依赖已按证据口径完成,同时没有别的步骤 in_progress;
// - blocked    至少一个直接依赖未完成/未验证/失败/取消,值是未满足的直接依赖 id;
// - retryable  failed 且 attempts < maxAttempts、依赖已满足、当前没有 active 步骤;
// - exhausted  failed 且 attempts >= maxAttempts,是交回人的终局条件,不是自动重试。
//
// cancelled 不算依赖满足:依赖被取消时后继必须被 replan 改写或一并取消,不能静默跳过。

import {
  PLAN_MAX_DEPENDENCIES,
  isPlanV3,
  type Plan,
  type PlanStep,
} from "./plan";

export interface PlanGraphIssue {
  code: "unknown_dependency" | "self_dependency" | "cycle" | "too_many_dependencies";
  stepId: string;
  dependencyId?: string;
}

export interface PlanGraphAnalysis {
  ready: string[];
  blocked: Record<string, string[]>;
  retryable: string[];
  exhausted: string[];
}

export interface PlanGraphOptions {
  /** true = completed 但无证据的步骤不算完成,依赖它的一律 blocked。 */
  requireVerified?: boolean;
}

function stepId(step: PlanStep, index: number): string {
  return step.id ?? `s${index + 1}`;
}

function depsOf(step: PlanStep): string[] {
  return step.dependsOn ?? [];
}

function maxAttemptsOf(step: PlanStep): number {
  return step.maxAttempts ?? 3;
}

function isDependencySatisfied(step: PlanStep, requireVerified: boolean): boolean {
  if (step.status !== "completed") return false;
  return requireVerified ? (step.evidence?.length ?? 0) > 0 : true;
}

/** 直接依赖里尚未满足的 id,按声明顺序。合并层用它拒绝「提前启动」。 */
export function unsatisfiedDependencies(
  plan: Plan,
  step: PlanStep,
  options: PlanGraphOptions = {},
): string[] {
  const requireVerified = options.requireVerified !== false;
  const byId = new Map<string, PlanStep>();
  plan.steps.forEach((item, index) => byId.set(stepId(item, index), item));
  return depsOf(step).filter((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return !dependency || !isDependencySatisfied(dependency, requireVerified);
  });
}

/** 结构校验:未知依赖、自依赖、超量依赖、环。重复 id 在归一化阶段已被消除,
 *  这里仍以最后一条为准;调用方必须先 normalizePlan 再校验。 */
export function validatePlanGraph(plan: Plan): PlanGraphIssue[] {
  if (!isPlanV3(plan)) return [];
  const issues: PlanGraphIssue[] = [];
  const ids = new Set(plan.steps.map((step, index) => stepId(step, index)));

  plan.steps.forEach((step, index) => {
    const id = stepId(step, index);
    const deps = depsOf(step);
    if (deps.length > PLAN_MAX_DEPENDENCIES) {
      issues.push({ code: "too_many_dependencies", stepId: id });
    }
    for (const dependencyId of deps) {
      if (dependencyId === id) {
        issues.push({ code: "self_dependency", stepId: id, dependencyId });
      } else if (!ids.has(dependencyId)) {
        issues.push({ code: "unknown_dependency", stepId: id, dependencyId });
      }
    }
  });

  // 环检测:三色 DFS,只对已知依赖走边。发现回边即报一次 cycle。
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map<string, PlanStep>();
  plan.steps.forEach((step, index) => byId.set(stepId(step, index), step));
  let cycle: PlanGraphIssue | null = null;

  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const step = byId.get(id);
    if (step) {
      for (const dependencyId of depsOf(step)) {
        if (dependencyId === id) continue;
        if (!byId.has(dependencyId)) continue;
        if (visit(dependencyId)) {
          if (!cycle) cycle = { code: "cycle", stepId: id, dependencyId };
          return true;
        }
      }
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };

  for (const id of ids) {
    if (visit(id)) break;
  }
  if (cycle) issues.push(cycle);
  return issues;
}

/** 当前可执行视图。纯推导,与计划存储无关。 */
export function analyzePlanGraph(
  plan: Plan,
  options: PlanGraphOptions = {},
): PlanGraphAnalysis {
  const requireVerified = options.requireVerified !== false;
  const analysis: PlanGraphAnalysis = { ready: [], blocked: {}, retryable: [], exhausted: [] };
  if (!isPlanV3(plan)) return analysis;

  const active = plan.steps.some((step) => step.status === "in_progress");
  plan.steps.forEach((step, index) => {
    const id = stepId(step, index);
    if (step.status === "completed" || step.status === "cancelled" || step.status === "in_progress") {
      return;
    }
    const unmet = unsatisfiedDependencies(plan, step, { requireVerified });
    if (step.status === "failed") {
      if ((step.attempts ?? 0) >= maxAttemptsOf(step)) {
        analysis.exhausted.push(id);
        return;
      }
      if (unmet.length > 0) {
        analysis.blocked[id] = unmet;
        return;
      }
      if (!active) analysis.retryable.push(id);
      return;
    }
    if (unmet.length > 0) {
      analysis.blocked[id] = unmet;
      return;
    }
    if (!active) analysis.ready.push(id);
  });
  return analysis;
}
