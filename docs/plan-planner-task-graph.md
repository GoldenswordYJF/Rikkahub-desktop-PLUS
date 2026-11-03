# 显式 Planner / 任务图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `update_plan` 的平坦清单升级为可校验的 DAG：步骤能声明依赖与重试预算，运行时能判定 ready / blocked / retryable / exhausted，并阻止未满足依赖或重试耗尽的任务被宣告完成。

**Architecture:** 不引入第二个规划模型、不新建执行器、不加数据库表。Planner 仍是模型调用的 `update_plan`；新增零 I/O 的图内核负责校验与推导，`mergePlan` 负责合并和代码所有的重试计数，现有 `AgentLoopController` 在聊天与 pi 两条轮边界上做完成校验和终局判定。计划仍存于消息流 tool part，权威快照继续使用 `metadata.planV2` 键。

**Tech Stack:** Bun 1.4.2、TypeScript、现有 `pc-server/tools/plan.ts`、现有双引擎轮边界钩子、React 19 + 现有 workbench 计划面板。

**Spec:** 本文同时是计划书与流程规范。现状依据：`pc-server/tools/plan.ts`、`pc-server/agent-loop/controller.ts`、`pc-server/conversations/orchestrator.ts`、`pc-server/pi-engine/runner.ts`、`docs/plan-autonomous-loop.md`。

> 状态：已实施（2026-11-02）。Task 1–4 完成；验收证据见文末「实施记录」。
>
> 范围：单 run 内的显式任务图、依赖校验、串行就绪调度、步骤级失败计数与重试预算、图感知完成校验、计划面板与历史投影。
>
> 不做：跨重启恢复、cron / 定时调度、全局审计、并行 DAG 执行器、自动重放写工具、独立 Planner 模型、子智能体编排协议改造、权限自动放行。
>
> 灰度：复用 `agentLoop.enabled`，不新增第二个开关。总开关默认关闭；关闭时工具 schema、回执、判定和 UI 行为与当前版本一致。开启实验即启用计划 v3，旧 v1/v2 计划仍按原语义读取。

## Global Constraints

- 不修改 `pi/`，不修改 `pc-server/workspace/tools/` 的工具内核；任务图属于会话计划层，不属于文件工具层。
- 不新建 run / plan 表；计划事实源仍是消息流，权威快照仍写 `metadata.planV2`，不改键名。
- 模型可改步骤与依赖，不能改 `goal / done_when / boundaries`，不能清零 `attempts`，不能在同一 run 内提高已锁定的 `max_attempts`。
- 失败重试不是自动重放：代码只注入提示与判定预算；写操作、危险命令和审批语义不因任务图改变。
- 单 run 最多一个 `in_progress`；多个 ready 分支由模型择一执行，本期不做并行调度。
- 每个步骤最多 8 个直接依赖；每步重试预算默认 3，允许首次设置为 1–5；全计划仍最多 20 步。
- `completed` 仍必须有工具证据才计入完成；依赖只有按同一证据口径完成后才算满足。
- `cancelled` 不等于依赖成功：依赖被取消时，后继保持 blocked，必须 replan 移除依赖或取消后继。
- v1/v2 的模型面 schema、回执文本与历史渲染保持原样；`details` 和 DTO 字段只增不改不删。
- 测试只跑目标文件；不调用真实计费供应商；不把已知 Windows EPERM / EBUSY flake 当回归。
- 不自动提交。实施完成后逐路径列出变更，只有用户明确要求才 `git add` / `git commit`。

## Review Focus

1. 环、自依赖、未知 id、重复 id 或畸形 `depends_on` 不能让消息流写入一份不可执行的计划；由 Task 1 的 `rejects invalid graphs without replacing the previous plan` 覆盖。
2. 重复提交同一 `failed` 状态不能刷高 `attempts`，重试耗尽后也不能靠改 `max_attempts` 或清计数复活；由 Task 1 的 `keeps retry counters and budgets code-owned` 覆盖。
3. 依赖被取消、失败或未验证时，后继不能被执行或静默算完成；由 Task 1 的 `computes ready and blocked from verified dependencies` 与 Task 3 的完成校验测试共同覆盖。
4. 任务图不能绕过审批或自动重放被拒绝的写工具；由 Task 3 的既有审批回归和 `does not replay denied tools while retrying a graph step` 覆盖。
5. 旧 v1/v2 历史、半截 JSON、缺字段快照和不可见来源不能让前端伪造依赖或失败状态；由 Task 2 的兼容测试与 Task 4 的历史投影测试覆盖。

---

# 流程规范

## 1. 模块所有权

| 模块 | 只负责 | 不得负责 |
| --- | --- | --- |
| `tools/plan.ts` | v3 schema、归一化、合并、重试计数、权威快照、模型回执 | 拓扑分析之外的业务决策、I/O、引擎调用 |
| `tools/plan-graph.ts`（新） | 依赖校验、环检测、ready / blocked / retryable / exhausted 推导 | 修改计划、读写消息流、调用工具 |
| `agent-loop/controller.ts` | 在轮边界读图，决定 continue / inject / halt | 改写计划、自动重试工具、改变目标或权限 |
| `conversations/orchestrator.ts` | 现有配置与钩子装配 | 另建图执行器或会话级第二份计划状态 |
| chat / pi 引擎 | 复用现有 `onToolRoundEnd` / `onFinalCandidate`，注入文本或类型化 halt | 各自复制 DAG 规则 |
| web-ui | 渲染权威计划及图分析结果 | 根据文本猜依赖、伪造历史来源、修改计划 |

## 2. 数据契约

### 2.1 计划 v3 字段

模型 JSON 使用 snake_case，TypeScript 使用 camelCase：

```ts
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export interface PlanStep {
  id?: string;
  content: string;
  status: PlanStepStatus;
  verify?: string;
  evidence?: string[];
  attempts?: number;
  lastError?: string | null;
  dependsOn?: string[];   // JSON: depends_on
  maxAttempts?: number;   // JSON: max_attempts
}
```

- `depends_on`：直接前置步骤 id 数组；去重、去空，超过 8 条由 `validatePlanGraph` 整体拒绝（归一化保留超量项，不静默截断）。
- `max_attempts`：首次发布时可设 1–5，缺省 3；同一 run 后续修改被拒绝并警告。
- `failed`：一次执行失败后的模型申报状态；不是终局。是否还能重试由 `attempts` 与 `maxAttempts` 决定。非 v3 输入里的 `failed` 仍按旧规则归一化为 `pending`，不改变 v1/v2 行为。
- `attempts`：已申报失败次数，代码所有。首次进入 `failed` 时加 1；重复提交 `failed` 不增加；新用户消息开启新 run 后才自然重置。
- 快照继续写 `metadata.planV2`，其中新增 `depends_on` 与 `max_attempts`；这是兼容容器版本，不另造 `planV3` 键。

### 2.2 图内核接口

新建 `pc-server/tools/plan-graph.ts`：

```ts
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

export function validatePlanGraph(plan: Plan): PlanGraphIssue[];
export function analyzePlanGraph(
  plan: Plan,
  options?: { requireVerified?: boolean },
): PlanGraphAnalysis;
```

推导口径：

- `ready`：`pending`、所有依赖已按证据口径完成、且当前没有另一个 `in_progress` 的步骤。
- `blocked`：至少一个直接依赖未完成、未验证、失败或取消；值是未满足的直接依赖 id，不猜间接原因。
- `retryable`：`failed`、`attempts < maxAttempts`、依赖已满足、且当前没有另一个 `in_progress` 的步骤。
- `exhausted`：`failed` 且 `attempts >= maxAttempts` 的步骤。
- `in_progress` 不出现在 `ready`；`completed` / `cancelled` 不出现在任何待执行集合。
- `requireVerified` 缺省为 `true`，与自主循环默认完成口径一致。

### 2.3 合并与拒绝规则

`PlanMergeResult` 增加 `accepted: boolean`；既有 v1/v2 合并恒为 `true`。

v3 出现以下情况时，保留上一版权威计划并返回模型面警告：

- 图校验失败：整份输入拒绝，不逐条修边，不静默改变依赖语义。
- 把依赖未满足的步骤置为 `in_progress`。
- 同时存在多个 `in_progress`。
- 在 `attempts >= maxAttempts` 后把同一步重新置为 `in_progress`。
- 修改已锁定步骤的 `max_attempts`，或提交 / 清零 `attempts`。

首次发布即非法时没有旧计划可保留：`planToolOutcome` 返回 `status: "plan_rejected"` 与警告，不写权威快照。合法输入仍返回现有 `plan_recorded` 回执并追加图统计字段，不回灌整份计划。

## 3. 执行与重试流程

1. 模型首次调用 `update_plan`，发布目标三件套、步骤 id、`depends_on`、可选 `max_attempts`。
2. 合并层校验图；通过后把权威快照随工具结果写入消息流。
3. 模型从 `ready` 中选择一个步骤置为 `in_progress`，再调用实际工具。多个 ready 分支仍串行，不承诺并行。
4. 步骤成功：模型附产生结果的 toolCallId，把步骤置为 `completed`；缺证据只显示“未验证”，不解除后继阻塞。
5. 步骤失败：模型把该步置为 `failed` 并写 `last_error`；合并层只在这头一次状态跃迁上增加 `attempts`。模型未申报时，控制器不从工具名或文本猜步骤归属，继续由现有同错 / 停滞规则兜底。
6. 未达到预算：该步进入 `retryable`，模型可改参数或 replan 后重试。不得自动重放原工具调用。
7. 达到预算：该步进入 `exhausted`；控制器以 `awaiting_user` 收尾，保留计划、证据与进度，由人选择继续或改目标。
8. 依赖失败、取消或未验证时，后继保持 `blocked`；replan 可以修改步骤和依赖，但不能重置失败计数或提高已锁预算。

## 4. 控制器判定顺序

`evaluateToolRound` 保持现有确定性优先级，只在 v3 插入图终局：

1. 同参同输出达到停滞上限：`stalled`。
2. 图里出现 `exhausted`：`awaiting_user`，优先于通用同错 replan，避免耗尽后继续烧轮次。
3. 同错误签名达到阈值且未耗尽：沿用现有 replan 注入与上限。
4. 同参同输出接近上限：沿用现有换路提示。
5. 其余：`continue`。

`evaluateFinal` 对 v3 不再只数 pending：

- 有 `exhausted`：立即 `awaiting_user`。
- 有 `retryable`：注入步骤 id、`attempts/maxAttempts` 与“改路线或明确无法完成”的提示。
- 有 `ready` / `in_progress` / `blocked` / 未验证：注入对应清单，不允许宣告成功。
- 同一未了结指纹注入一次后仍无进展：沿用现有 `stalled`，避免无限重采样。
- 只有所有未取消步骤均按证据口径完成，才允许 `succeeded`。

终局仍使用 `AgentLoopHaltError`；run 状态映射不变，不新增数据库状态。

## 5. 双引擎与权限纪律

- 聊天通路继续使用 `inference-engine/tool-loop.ts` 的工具批边界与最终轮钩子。
- pi 通路继续使用 `pi-engine/runner.ts` 的 `turn_end`；提示走 `session.steer`，halt 记录后 `session.abort` 并由 runner 上抛类型化错误。
- 不在两条通路复制图算法；两边只消费同一个 `LoopDecision`。
- 任务图不修改 `workspace/approval.ts`、`tools/approval.ts`、写边界、沙盒或审批端点。
- 被拒绝的工具不进入自动重试；模型后续重试仍是一次全新的工具调用，必须重新过既有审批矩阵。
- steering 用户补发优先于图提示；真实新用户消息开启新 run，旧图不参与新 run 的完成校验。

## 6. 测试、验收与交付

- 每个 Task 先写失败测试，再写最小实现，再跑目标文件到通过。
- 至少保留四组回归：`tools/plan.test.ts`、`agent-loop/controller.test.ts`、`agent-loop/acceptance.test.ts`、`agent-loop/plan-projection.test.ts`。
- 双引擎验收继续使用脚本化 adapter / mock，不调用真实供应商。
- 前端改动后跑目标测试与 `bun run typecheck`；需要 17455 演示时重新 build web-ui，并统一走 `demo-profiles/tools/demo-server.sh`。
- 完成后更新本文状态与验收证据，不另建重复说明文档。
- 最终人工验收必须能演示：菱形 DAG、环拒绝、失败重试 3 次后交人、依赖未验证不解除阻塞、总开关关闭时旧行为不变。

---

# 实施任务

### Task 1: DAG 内核、v3 schema 与代码所有的重试合并

**Files:**
- Create: `pc-server/tools/plan-graph.ts`
- Create: `pc-server/tools/plan-graph.test.ts`
- Modify: `pc-server/tools/plan.ts`
- Modify: `pc-server/tools/plan.test.ts`

**Interfaces:**
- Consumes: 现有 `Plan`、`PlanStep`、`mergePlan`、`toPlanSnapshot`、`planToolOutcome`。
- Produces: `PlanGraphIssue`、`PlanGraphAnalysis`、`validatePlanGraph()`、`analyzePlanGraph()`、`isPlanV3()`；扩展后的 `PlanStep` / `PlanSnapshot`、`PlanMergeResult.accepted` 与 `PlanMergeOptions.taskGraph?: boolean`。

- [ ] **Step 1: 写图校验与推导的失败测试**

在 `plan-graph.test.ts` 覆盖：`accepts a diamond DAG`、`rejects unknown self and cyclic dependencies`、`computes ready and blocked from verified dependencies`、`separates retryable from exhausted failures`、`treats cancelled dependencies as unsatisfied`。菱形用 `s1 → s2/s3 → s4`，明确断言集合内容而非只看长度。

- [ ] **Step 2: 跑测试并确认因模块 / 函数不存在而失败**

Run（在 `pc-server/` 下）: `bun test tools/plan-graph.test.ts`
Expected: FAIL，提示找不到 `./plan-graph` 或导出函数不存在。

- [ ] **Step 3: 实现纯函数图内核并扩展 v3 数据形状**

按 §2.2 接口实现零 I/O 的校验与分析；在 `plan.ts` 增加 `failed`、`dependsOn`、`maxAttempts`、常量 `PLAN_MAX_DEPENDENCIES = 8`、默认预算 3 与上限 5。归一化只接受数组中的字符串依赖，去重去空并钳制条数；快照增加 `depends_on` / `max_attempts`，不改变快照键名。

- [ ] **Step 4: 写合并与重试所有权的失败测试，再实现**

在 `plan.test.ts` 增加：`rejects invalid graphs without replacing the previous plan`、`increments attempts only on a new transition to failed`、`keeps retry counters and budgets code-owned`、`rejects starting a blocked or second active step`、`rejects restarting an exhausted step`。随后扩展 `mergePlan` 与 `planToolOutcome`；v1/v2 旧测试必须原样通过。

- [ ] **Step 5: 跑目标测试确认通过**

Run: `bun test tools/plan-graph.test.ts tools/plan.test.ts`
Expected: PASS；既有 v1/v2 用例零失败。

### Task 2: 双引擎工具声明、执行与权威快照接线

**Files:**
- Modify: `pc-server/tools/definitions.ts`
- Modify: `pc-server/tools/bound.ts`
- Modify: `pc-server/tools/execution.ts`
- Modify: `pc-server/tools/plan-context.ts`
- Modify: `pc-server/tools/tool-protocol-contract.test.ts`
- Modify: `pc-server/tools/plan-context.test.ts`
- Modify: `pc-server/agent-loop/plan-projection.test.ts`

**Interfaces:**
- Consumes: Task 1 的 v3 schema、`planToolOutcome`、`PlanMergeOptions.taskGraph`、权威快照。
- Produces: `planToolDescription(v2, graph)`、`planToolParameters(v2, graph)`、`openAiPlanTool(enabled, v2, graph)`。生产环境以 `agentLoop.enabled` 同时开启 v2 与 graph；读取历史时不受当前开关影响。

- [ ] **Step 1: 写声明与执行门控的失败测试**

断言总开关关闭时 schema 与旧版一致；开启时步骤 schema 包含 `depends_on` / `max_attempts` 且状态枚举包含 `failed`。执行测试固定：graph 关闭时手工提交 v3 字段不生效，graph 开启时合法图返回权威快照，非法首次图返回 `plan_rejected` 且无快照。

- [ ] **Step 2: 跑测试并确认失败**

Run: `bun test tools/tool-protocol-contract.test.ts tools/plan-context.test.ts`
Expected: FAIL，缺少 v3 声明或 graph 执行选项。

- [ ] **Step 3: 接通唯一声明与执行入口**

在 `definitions.ts` 扩展 schema 与英文工具说明，明确“先发布图、只启动 ready 步、失败标 failed、不能改计数”；在 `bound.ts` 从 `agentLoop.enabled` 传入 graph；在 `execution.ts` 把同一开关传给 `planToolOutcome`。聊天与 pi 继续共用这两个入口，不在 `pi-engine/general-tools.ts` 另写规则。

- [ ] **Step 4: 固定历史读取与投影兼容**

`plan-context.ts` 与 `planFromToolPart` 读取权威快照时保留 v3 字段，旧 v2 快照缺字段时用默认空依赖与预算 3；`plan-projection.test.ts` 增加 v3 来源、证据定位与旧计划不显示图语义的断言。

- [ ] **Step 5: 跑目标测试确认通过**

Run: `bun test tools/tool-protocol-contract.test.ts tools/plan-context.test.ts agent-loop/plan-projection.test.ts tools/plan.test.ts tools/plan-graph.test.ts`
Expected: PASS；关闭开关的旧契约断言不变。

### Task 3: 图感知控制器与双引擎验收

**Files:**
- Modify: `pc-server/agent-loop/controller.ts`
- Modify: `pc-server/agent-loop/controller.test.ts`
- Modify: `pc-server/agent-loop/acceptance.test.ts`
- Test only: `pc-server/inference-engine/tool-loop.test.ts`
- Test only: `pc-server/pi-engine/runner-steering.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isPlanV3()` / `analyzePlanGraph()`，现有 `LoopDecision`、`AgentLoopHaltError` 与双引擎钩子。
- Produces: 图感知的 `evaluateToolRound()` / `evaluateFinal()`；`PlanVerification` 可增加 `ready`、`blocked`、`retryable`、`exhausted` 数组，既有字段不变。

- [ ] **Step 1: 写控制器失败测试**

覆盖：`halts awaiting_user when a step exhausts its retry budget`、`injects retryable step id and attempt budget`、`does not finish while ready or blocked steps remain`、`does not unblock dependents of unverified completions`、`keeps legacy plan completion semantics unchanged`。

- [ ] **Step 2: 跑控制器测试并确认失败**

Run: `bun test agent-loop/controller.test.ts`
Expected: FAIL，当前控制器不识别图状态。

- [ ] **Step 3: 按 §4 顺序实现最小判定分支**

复用 `analyzePlanGraph`，不在控制器复制拓扑逻辑；保持同参重复、同错 replan、用户 steering 的既有优先级。注入文本只包含步骤 id、计数和必要错误摘要，不把整份计划或工具正文塞回模型。

- [ ] **Step 4: 补双引擎与权限验收**

在 `acceptance.test.ts` 用脚本化 adapter 演示：菱形图按依赖完成；第三次失败进入 `awaiting_user`；新用户“继续 / 改目标”后旧图不污染新 run；`does not replay denied tools while retrying a graph step` 断言拒绝次数与审批调用次数不增加。聊天 / pi 各至少一条真实轮边界用例。

- [ ] **Step 5: 跑双引擎目标回归**

Run: `bun test agent-loop/controller.test.ts agent-loop/acceptance.test.ts inference-engine/tool-loop.test.ts pi-engine/runner-steering.test.ts`
Expected: PASS；无真实网络请求，无新增 Windows 特有失败。

### Task 4: 计划面板、历史投影与界面验收

**Files:**
- Modify: `web-ui/app/components/workbench/plan-panel.tsx`
- Modify: `web-ui/app/lib/plan-model.ts`（仅在视图需要显式 v3 标记时）
- Modify: `web-ui/app/locales/zh-CN/common.json`
- Modify: `web-ui/app/locales/en-US/common.json`
- Create: `web-ui/app/tests/plan-graph-panel.test.tsx`
- Modify: `web-ui/app/tests/agent-run-event-list.test.tsx`（仅当复用组件受影响）

**Interfaces:**
- Consumes: `@server/tools/plan` 的 `isPlanV3` 与 `@server/tools/plan-graph` 的 `analyzePlanGraph`，现有 `PlanEntry` / `RunPlanView`。
- Produces: 计划项的 ready / blocked / retryable / exhausted 展示、依赖 id、`attempts/maxAttempts` 与失败摘要；不改变消息定位与历史选择接口。

- [ ] **Step 1: 写面板失败测试**

用同一菱形计划断言：根步骤 ready、后继显示 blocked 及直接依赖 id、失败步骤显示 `1/3`、耗尽步骤显示终局原因；旧 v1/v2 计划不出现这些徽标。历史投影来源不可见时仍沿用现有 `visible:false` 标注，不伪造位置。

- [ ] **Step 2: 跑测试并确认失败**

Run（在 `web-ui/` 下）: `bun test app/tests/plan-graph-panel.test.tsx`
Expected: FAIL，面板尚无图状态与文案。

- [ ] **Step 3: 实现只读图视图**

面板从权威 `Plan` 调同一个 `analyzePlanGraph`，不维护前端第二份图状态。复用现有步骤行、证据徽标与 toolCall 定位；新增紧凑徽标和依赖文本，失败摘要默认折叠，避免 20 步图把面板撑爆。

- [ ] **Step 4: 补齐中英文案并跑目标回归**

语言键只增不改；运行计划面板与既有 agent-run 事件测试，确认历史 run 切换、分页和未知事件渲染不受影响。

Run: `bun test app/tests/plan-graph-panel.test.tsx app/tests/agent-run-event-list.test.tsx app/tests/agent-run-history-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查与最终回归清单**

Run（在 `web-ui/` 下）: `bun run typecheck`
Run（在 `pc-server/` 下）: `bun run typecheck`
Expected: 两端 0 错。

随后在 `pc-server/` 下跑：

```bash
bun test tools/plan-graph.test.ts tools/plan.test.ts tools/plan-context.test.ts \
  agent-loop/controller.test.ts agent-loop/acceptance.test.ts \
  agent-loop/plan-projection.test.ts workspace/runtime.test.ts \
  workspace/tools/tools.test.ts workspace/tools/fallback-tools.test.ts \
  pi-engine/workspace-tools.test.ts
```

Expected: PASS；若只剩已知 Windows EPERM / EBUSY flake，逐项记录，不改业务语义迁就测试。

## 完成定义

- 模型能发布带 `depends_on` 与 `max_attempts` 的显式 DAG，非法图被完整拒绝且保留旧权威计划。
- ready / blocked / retryable / exhausted 由同一份纯函数在控制器和前端复用，无双份漂移。
- 步骤失败计数真实递增、重复申报不递增、耗尽后不能自行复活；没有自动重放写工具。
- 聊天与 pi 都能阻止未了结图宣告成功，并在重试耗尽后进入 `awaiting_user`。
- 当前计划与历史 run 都能展示依赖、预算、失败和证据位置；旧 v1/v2 会话渲染不变。
- `agentLoop.enabled=false` 时，工具声明、执行回执、循环与 UI 行为保持旧版。
- 目标测试与两端 typecheck 通过，验收证据回填到本文；未夹带生命周期、调度或全局审计改造。

## 实施记录（2026-11-02）

| Task | 结果 | 关键落点 |
| --- | --- | --- |
| T1 | ✅ | `pc-server/tools/plan.ts`、新增 `pc-server/tools/plan-graph.ts`；v3 依赖/预算/`failed`、非法图整份拒绝、拒绝时回写旧权威快照 |
| T2 | ✅ | `definitions.ts` / `bound.ts` / `execution.ts` / `plan-context.ts` 同一开关；历史投影保留 v3 字段，旧 v1/v2 形状不变 |
| T3 | ✅ | `agent-loop/controller.ts` 图感知完成校验与 `exhausted → awaiting_user`；聊天引擎脚本化 adapter 验收通过 |
| T4 | ✅ | `web-ui/app/components/workbench/plan-panel.tsx` 徽标与依赖展示、中英文案、前端渲染测试 |

验收命令与结果：

- `pc-server` typecheck：我们侧 0 错。
- `web-ui` typecheck：0 错。
- 后端目标回归 166 项：165 pass，1 fail 为已知 Windows `C:\WINDOWS\Temp` EPERM flake（`workspace/runtime.test.ts` 宽界系统目录写入），不是本改动回归。
- 前端 `plan-graph-panel.test.tsx`：4 pass。

已知边界（与方案一致，不扩大范围）：

- 失败计数基于模型申报的 `failed` 状态；模型未申报时控制器不猜步骤归属，仍由同错/停滞规则兜底。
- 多 ready 分支串行执行，本期没有并行 DAG 调度器。
- 跨重启恢复、cron 调度、全局审计仍未实现。
