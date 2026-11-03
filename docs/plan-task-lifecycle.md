# 任务生命周期（长跑 / 恢复 / 调度 / 审计）计划书与流程规范

**Goal:** 在现有 `pc_generation_run` / `pc_generation_run_event` 之上补齐任务生命周期：长任务有耐久检查点，进程重启后孤儿运行被收敛，用户能显式恢复中断任务，任务能按时间触发，并能跨会话查询与导出审计记录。

**Architecture:** 不新造执行器。恢复复用 `generateAnswer` 与消息流中的计划/工具证据，旧 run 保持终局，新 run 通过 `resumed_from_run_id` 关联；调度复用现有消息队列和 `generateAnswer`，使用 `once / fixed_interval` 两种耐久计划；审计复用现有 run、事件、计划与边界投影。所有自动动作只创建任务，不自动批准工具、不自动重放副作用。

**Tech Stack:** Bun 1.4.2、`bun:sqlite`、现有 `agent-loop` 运行记录、现有消息队列与双引擎编排、React 19 现有 AgentBot 设置与运行面板。

**Spec:** 本文同时是计划书与流程规范。现状依据：`pc-server/agent-loop/{schema,run-store,run-tracker,types}.ts`、`pc-server/conversations/{orchestrator,message-queue}.ts`、`pc-server/api/handlers/conversations.ts`、`docs/plan-autonomous-loop.md`、`docs/plan-agentbot-observability.md`、`docs/plan-planner-task-graph.md`。

> 状态（2026-11-03 完成）：L1–L4 全部落地并通过目标回归，未提交代码。
>
> 验收基线：后端生命周期目标回归 `bun test api/agent-run-audit.test.ts agent-loop/run-store.test.ts agent-loop/run-recovery.test.ts agent-loop/scheduler.test.ts agent-loop/plan-projection.test.ts api/task-schedules.test.ts api/agent-run-resume.test.ts api/agent-runs-routes.test.ts` = 61 通过 / 0 失败；邻近回归 `agent-loop/acceptance agent-loop/run-tracker tools/plan-context backup/android-contract-sync api/agent-loop-settings-route` = 35 通过 / 5 skip / 0 失败；前端 `bun test app/tests/{agent-run-audit,agent-run-schedules,agent-run-history-store,agent-run-event-list,plan-graph-panel}` = 31 通过 / 0 失败；两端 typecheck 均 0 错误。
>
> 实施记录与偏差见文末「实施记录」一节。
>
> 交付分四段，可独立验收：L1 长跑检查点与重启收敛；L2 用户显式恢复；L3 耐久调度；L4 全局审计查询/导出。严格按 Task 1 → Task 4 顺序推进；每段目标测试与 typecheck 全绿后才进入下一段。
>
> 明确不做：进程崩溃后自动续跑、在途 Provider 流的无缝接续、cron 表达式、分布式多实例调度、不可篡改/WORM 审计、自动审批、写工具自动重放、跨设备任务同步。

## Global Constraints

- 重启只收敛状态，不自动恢复生成；恢复必须由用户点击或有效调度显式触发。
- 旧 run 一旦进入终局就不复活；恢复创建新 run，并以 `resumed_from_run_id` 指向旧 run。
- 不自动重放任何工具。恢复/调度产生的新一轮模型请求仍逐次经过现有审批与工作区边界。
- 计划与工具证据的权威来源仍是消息流；run/event 只存摘要、计数和小 payload，不新增正文审计库。
- 调度只支持 `once` 与 `fixed_interval`；最小间隔 60 秒，最长 30 天；不支持 cron DSL。
- 每个会话最多 20 条调度；单条调度同一时刻最多补跑一次，排队不无限堆积。
- 审计仍是保留窗口内的产品审计：每会话继续保留最近 20 个 run，不能宣称完整或不可篡改。
- 不放宽现有 `AgentRunStatus` 终局语义；`awaiting_user` 在记录上仍映射为 `stalled`。
- 新 PC 设置字段默认关闭并登记安卓导出剥离；`agentLoop` 整块现有剥离规则保持不变。
- 不修改 `pi/` 与 `pc-server/workspace/tools/`；不改审批、写边界、沙盒语义。
- 测试只跑目标文件与本地 mock；不调用真实计费供应商；不自动提交代码。

## Review Focus

1. 进程在 `insertRun` 后、首条事件前崩溃，或只留下半截事件时，启动收敛仍必须幂等且不能把新进程的活动 run 误杀；由 L1 的崩溃矩阵测试覆盖。
2. 旧 run 正在运行、已被替换、没有有效计划、或工具曾被拒绝时，恢复不能制造第二个活动 run，也不能重放旧工具；由 L2 的恢复守卫测试覆盖。
3. 调度到期后进程崩溃、重启时错过多个周期、同一会话仍在生成时，不能重复补跑或让队列无限增长；由 L3 的 misfire / overlap 测试覆盖。
4. 会话被删除、调度被禁用、目标为空或非法间隔，不能让已删会话复活，也不能出现忙循环；由 L3 的输入与生命周期测试覆盖。
5. 审计筛选、游标、跨会话归属和导出必须不被伪造 id 或非法参数绕过，且不输出工具正文/密钥；由 L4 的 API 契约与脱敏测试覆盖。

---

# 流程规范

## 1. 概念与所有权

| 概念 | 定义 | 事实源 |
| --- | --- | --- |
| run | 一次 `generateAnswer` 的执行记录 | `pc_generation_run` |
| checkpoint | 可用于恢复决策的耐久摘要：run 状态、最大事件 seq、最后事件时间、计划/边界投影位置 | run + event + 消息流，不另存正文 |
| recovery | 对旧中断 run 的只读判定与用户显式续跑动作 | 旧 run 终局 + 新 run 链接 |
| schedule | 一条耐久时间规则，到期向指定会话投递一个目标 | 新表 `pc_task_schedule` |
| audit | 对保留 run 的全局筛选、详情定位与 JSONL 导出 | run/event/projection，不新增第二套日志 |

模块边界：

- `run-store.ts`：唯一 SQL 读写入口；新增启动收敛、恢复链接、审计查询，不让路由散落 SQL。
- `run-recovery.ts`（L1 已落地）：纯判定与 DTO 组装，决定 `none / suspended / new_run` 三种恢复方式。
- `orchestrator.ts`：只负责把恢复/调度上下文传入 `beginAgentRun` 和既有生成入口。
- `scheduler.ts`（新）：唯一调度 tick、到期领取、misfire 处理与队列投递入口。
- `api/handlers/`：校验归属和输入，不实现恢复或调度算法。
- web-ui：展示可恢复性、调度与审计，不在前端推断 run 是否可恢复。

## 2. 长跑与 checkpoint

### 2.1 不新增“长任务执行器”

长任务继续受现有 256 轮与 120 秒流空闲超时约束；本方案不新增强制 wall-clock 超时，也不承诺跨进程接续在途 HTTP 流。长任务的可恢复性来自持续落库，而不是内存里的 `AgentRunTracker`。

checkpoint 由以下数据现算，不复制正文：

```ts
export interface RunCheckpointDto {
  throughSeq: number;
  lastEventAt: number | null;
  planAvailable: boolean;
  boundaryCount: number;
}
```

- `throughSeq`：该 run 已落库的最大事件 seq；没有事件为 0。
- `lastEventAt`：最后一条事件时间；没有事件为 null。
- `planAvailable`：现有 run projection 是否能还原计划。
- `boundaryCount`：现有边界投影去重后的数量。

每轮、工具结果、审批、重试、replan、终局仍走现有事件写入。恢复和审计读取同一 checkpoint，不另建“检查点表”。

### 2.2 启动收敛矩阵

新增 `reconcileAgentRunsAfterBoot(now = Date.now())`，在会话库打开并完成建表后、任何新生成或调度 tick 前调用：

| 启动时记录 | 处理 | 恢复方式 |
| --- | --- | --- |
| `running` | 改为 `stopped`，`stopReason=interrupted`，写 `endedAt` 与 `run_finished`（payload `reason=process_restart`） | 经用户判定后可 `new_run` |
| `suspended` | 保留，等待恢复接口验证消息中的 pending 工具卡 | 仅有效暂停可 `suspended` |
| 已终局 | 不动 | 仅 `stopped/interrupted` 可评估恢复 |
| 已有 `reason=process_restart` 的中断事件 | 不重复写 | 幂等 |

数据目录锁保证正常部署只有一个写入进程，所以启动时的 `running` 都是上一进程遗留。函数必须返回 `{ runningStopped, suspendedKept }` 供启动日志使用；写失败只记错误，不阻塞服务启动，但恢复入口必须拒绝“看起来还在 running”的旧记录。

## 3. 中断恢复

### 3.1 恢复判定

```ts
export type AgentRunResumeMode = "none" | "suspended" | "new_run";

export interface AgentRunRecoveryDto {
  runId: string;
  mode: AgentRunResumeMode;
  reason: string | null;
  checkpoint: RunCheckpointDto;
}
```

判定顺序：

1. run 不属于该会话：`none`，路由 404。
2. 当前会话已有活动生成：`none`，原因 `conversation_busy`；前端不得并发恢复。
3. `suspended` 且消息流中存在与该 run 对应的 pending 审批：`suspended`，沿用现有批准后续跑。
4. `stopped + stopReason=interrupted` 且会话仍存在：`new_run`。
5. `running / succeeded / failed / exhausted / stalled` 或找不到必要消息锚点：`none`，给明确原因。

### 3.2 恢复执行

`POST /api/conversations/:id/agent-runs/:runId/resume`：

- 仅接受 `new_run`；`suspended` 继续走原审批端点，不能经本接口绕过审批。
- 在会话末尾创建真实 USER 消息，模型面文本固定为：
  `Resume the interrupted task. Reuse the existing plan and tool evidence; do not repeat completed steps or replay denied tools.`
- 消息带 `{ type: "run_resume", runId }` 注解。该注解与 steering 一样不切计划边界，保证旧计划仍可读；普通新用户消息仍然切 run。
- 调 `generateAnswer(conversation)`，新 run 在 `beginAgentRun` 写入 `resumed_from_run_id=旧 run.id`。
- 返回 `{ status: "resumed", resumedFromRunId }`；新 runId 通过既有 SSE/快照提供，不在路由里等待生成完成。

`pc_generation_run` 通过幂等 migration 增加可空列 `resumed_from_run_id` 与 `schedule_id`；`AgentRunSummary` 增加同名字段（camelCase），旧记录为 null。

禁止事项：不改旧 run 状态、不复制旧工具卡成新调用、不把 denied 改成 approved、不自动执行队列里已冻结的旧消息。

## 4. 耐久调度

### 4.1 表与输入

```sql
CREATE TABLE IF NOT EXISTS pc_task_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once', 'fixed_interval')),
  run_at INTEGER,
  interval_seconds INTEGER,
  next_run_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  misfire_policy TEXT NOT NULL DEFAULT 'catch_up_once'
    CHECK(misfire_policy IN ('skip', 'catch_up_once')),
  last_run_at INTEGER,
  last_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pc_task_schedule_due
  ON pc_task_schedule(enabled, next_run_at);
```

输入约束：

- `goal` trim 后 1–2000 字符。
- `once.run_at` 必须是未来毫秒时间戳；到期后自动禁用。
- `fixed_interval.interval_seconds` 为 60–2592000 的整数。
- `misfire_policy` 缺省 `catch_up_once`；`skip` 只前进到未来时点。
- 每会话最多 20 条；目标会话不存在返回 404，不由调度器重建。删除会话时在现有删除流程里显式删除其 schedule，不能只依赖 `ON DELETE CASCADE`（本仓不假设 `foreign_keys` pragma 恒开启）。

### 4.2 tick、领取与 misfire

`AgentTaskScheduler` 每 15 秒 tick 一次，定时器 `unref`；启动收敛完成后才启动，优雅停机时停止。

每次 tick：

1. 事务内领取最多 20 条 `enabled=1 AND next_run_at<=now` 的记录，并先推进 `next_run_at` 或禁用，避免同一进程重复领取。
2. `skip`：不投递，直接计算下一个未来时点。
3. `catch_up_once`：只投递一次，然后按当前时间计算下一个未来时点；漏掉的中间周期不逐条补。
4. 会话正在生成或队列非空：不投递。`catch_up_once` 将 `next_run_at` 退避到 `now + 60_000`，空闲后只补一次；`skip` 直接前进到下一个未来时点。两种策略都不会逐周期堆积。
5. 投递复用消息队列，USER 消息带 `{ type:"scheduled", scheduleId }`；普通新任务边界，不复用上一次计划。
6. `generateAnswer` 创建 run 时写入 `schedule_id`，并回写 `last_run_at / last_run_id`。

所有时间用 `Date.now()`，注入到 tick 便于测试；禁止在 scheduler 内直接 `setTimeout` 递归模拟时间测试。

API：

- `GET/POST /api/conversations/:id/task-schedules`
- `PATCH/DELETE /api/conversations/:id/task-schedules/:scheduleId`

PATCH 修改目标或时间规则时重新计算 `next_run_at`；DELETE 只删调度，不删历史 run。

## 5. 审计查询与导出

### 5.1 全局只读查询

新增 `GET /api/agent-runs`，仅返回摘要，不返回正文：

```ts
export interface AgentRunAuditQuery {
  conversationId?: string;
  status?: AgentRunStatus;
  engine?: string;
  scheduleId?: string;
  beforeStartedAt?: number;
  limit?: number; // 默认 50，最大 100
}
```

排序固定 `started_at DESC, id DESC`；`beforeStartedAt` 必须为正整数；非法状态/游标返回 400，不静默变成全量查询。返回 `runs` 与下一页游标。

### 5.2 单 run JSONL 导出

`GET /api/conversations/:id/agent-runs/:runId/export`：

- 第一行 `{ type:"run", data: AgentRunSummary }`。
- 后续每行 `{ type:"event", data: AgentRunEventDto }`，按 seq 升序流式输出。
- 最后一行固定为 `{ type:"projection", data: RunProjectionDto }`；计划不可用时由现有 `unavailableReason` 如实表达。
- 响应类型为 `application/x-ndjson; charset=utf-8`，事件逐页读取，不一次性拼接整份导出。
- 不包含消息正文、工具输出正文、Provider 密钥、认证头；沿用现有摘要/ payload 脱敏。
- 跨会话 runId 一律 404，不用“空导出”掩盖越权。

### 5.3 审计边界

- 全局查询只覆盖未被淘汰的记录；UI 明示“每会话保留最近 20 次运行”。
- 不提供 DELETE run / 清审计接口。
- 审计详情定位复用现有会话、run、计划、审批与边界投影，不复制一份详情模型。
- 导出文件名只含会话/ run 的短 id 与日期，不包含用户目标原文。

## 6. 设置、权限与数据纪律

- L1/L2/L4 只读与恢复能力跟随 `agentLoop.enabled`；关闭时不显示恢复/审计入口，已有记录仍只读保留。
- L3 调度新增 `agentLoop.schedulingEnabled`，默认 false；总开关或调度开关关闭时 tick 不投递，但耐久记录不删除。
- 新字段嵌在现有 `agentLoop` 内，安卓导出继续整块剥离；补导出/导入回归，不新增顶层 PC 设置。
- 调度消息与恢复消息都不能豁免审批；权限档收窄时沿用现有缓存/激活集失效规则。
- 不把调度目标、审计正文写进 server.log；错误日志只带 id 与分类原因。

## 7. 测试与验收

- L1 用临时数据目录构造崩溃库，连续调用两次启动收敛，验证幂等与新 run 不受影响。
- L2 用 mock 生成入口验证只创建一个新 run、链接正确、旧 run 不变、denied 工具不新增执行。
- L3 用注入时钟 + 内存/临时 SQLite，不等待真实 15 秒；验证 once、interval、misfire、队列占用、删除会话与重启。
- L4 验证筛选、分页、归属、导出顺序与脱敏；大 run 仍按事件流/分页，不把全部正文载入内存。
- 两端 typecheck 必须 0 错；每个阶段完成后才进入下一阶段。
- 不自动提交；实施完成后逐路径列出变更。

---

# 实施任务

### Task 1: 长跑 checkpoint、run 链接字段与启动收敛

**Files:**
- Create: `pc-server/agent-loop/run-recovery.ts`
- Create: `pc-server/agent-loop/run-recovery.test.ts`
- Modify: `pc-server/agent-loop/schema.ts`
- Modify: `pc-server/agent-loop/run-store.ts`
- Modify: `pc-server/agent-loop/run-store.test.ts`
- Modify: `pc-server/agent-loop/types.ts`
- Modify: `pc-server/conversations/index.ts`
- Modify: `pc-server/bootstrap.ts`

**Interfaces:**
- Consumes: 现有 run/event 表、`ensureAgentLoopTables`、现有 projection。
- Produces: `RunCheckpointDto`、`AgentRunRecoveryDto`、`AgentRunResumeMode`、`reconcileAgentRunsAfterBoot(now?)`、`getRunCheckpoint(runId)`、`getRunRecovery(conversationId, runId)`；run 摘要新增 `resumedFromRunId` / `scheduleId`。

- [x] **Step 1: 写启动崩溃矩阵与 checkpoint 失败测试**

覆盖：无事件的 running、带事件的 running、suspended、已终局、重复收敛；断言旧 running 变 `stopped/interrupted`、只写一次 `process_restart`、endedAt 固定为注入时间，checkpoint 取最大 seq/时间。

- [x] **Step 2: 跑测试确认失败**

Run（在 `pc-server/` 下）: `bun test agent-loop/run-recovery.test.ts agent-loop/run-store.test.ts`
Expected: FAIL，缺少 recovery 模块/函数或新字段。

- [x] **Step 3: 实现幂等 migration、checkpoint 与启动收敛**

在 `ensureAgentLoopTables` 后以 `PRAGMA table_info` 检查并 `ALTER TABLE ADD COLUMN resumed_from_run_id TEXT` / `schedule_id TEXT`；所有读取显式列名兼容旧库。收敛只处理启动前 `running`，不改 suspended/终局；同一事务更新 run 并追加终局事件。

- [x] **Step 4: 接入启动顺序并实现恢复只读判定**

在 DB 建表后、调度/生成开放前调用收敛；`run-recovery.ts` 按 §3.1 实现纯判定，活动会话由调用方注入 `busy`，消息 pending/锚点由现有会话读取helper提供，不在 store 层猜。

- [x] **Step 5: 跑目标测试与类型检查**

Run: `bun test agent-loop/run-recovery.test.ts agent-loop/run-store.test.ts agent-loop/run-tracker.test.ts`
Run: `bun run typecheck`
Expected: PASS，启动顺序无循环导入。
2026-11-03 复核：run-recovery + run-store 16 通过；typecheck 当前仅剩 Task 2 契约测试对 `runResumeTarget` 的预期引用错误，L1 本身无类型错误。

### Task 2: 用户显式恢复与新 run 链接

**Files:**
- Modify: `pc-server/conversations/orchestrator.ts`
- Modify: `pc-server/tools/plan-context.ts`
- Modify: `pc-server/agent-loop/run-tracker.ts`
- Modify: `pc-server/agent-loop/run-store.ts`
- Modify: `pc-server/api/handlers/conversations.ts`
- Create: `pc-server/api/agent-run-resume.test.ts`
- Modify: `web-ui/app/components/workspace/agent-run-panel.tsx`
- Modify: `web-ui/app/locales/{zh-CN,en-US}/common.json`

**Interfaces:**
- Consumes: Task 1 的 `getRunRecovery`、`resumedFromRunId`、checkpoint。
- Produces: `POST .../agent-runs/:runId/resume`、`run_resume` 消息注解、`beginAgentRun` 可选 `resumedFromRunId` / `scheduleId` 上下文。

- [x] **Step 1: 写恢复 API 与计划边界失败测试**

覆盖：成功 new_run、跨会话 404、running/busy 409、suspended 不走本接口、重复点击只产生一个活动生成、`run_resume` 消息不切旧计划、普通 USER 仍切边界。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test api/agent-run-resume.test.ts tools/plan-context.test.ts`
Expected: FAIL，路由/注解语义尚未实现。
2026-11-03 复核：`api/agent-run-resume.test.ts` 5 项均因路由未命中而失败，符合本步预期；实现 Step 3 后必须转绿，不能改测试去迁就路由。

- [x] **Step 3: 实现恢复消息、run 链接与路由守卫**

复用现有会话尾部 USER + `generateAnswer`，不新增第二生成路径；`beginAgentRun` 把注解中的 runId 写入 `resumed_from_run_id`。恢复前再次检查 recovery DTO，防止判定后并发点击。

- [x] **Step 4: 接运行面板恢复按钮与状态文案**

仅在服务端返回 `new_run` 时显示；点击后禁用并跟随既有 SSE，不在前端伪造新 run。失败显示原因；旧 run 仍保持只读终局。

- [x] **Step 5: 跑恢复与既有审批回归**

Run: `bun test api/agent-run-resume.test.ts tools/plan-context.test.ts agent-loop/run-tracker.test.ts agent-loop/acceptance.test.ts`
Expected: PASS，无 denied 工具自动重放。

### Task 3: 耐久 once / fixed_interval 调度

**Files:**
- Create: `pc-server/agent-loop/scheduler.ts`
- Create: `pc-server/agent-loop/scheduler.test.ts`
- Modify: `pc-server/agent-loop/schema.ts`
- Modify: `pc-server/agent-loop/run-store.ts`
- Modify: `pc-server/foundation/types/settings/agent-loop-config.ts`
- Modify: `pc-server/conversations/message-queue.ts`
- Modify: `pc-server/conversations/orchestrator.ts`
- Modify: `pc-server/api/handlers/conversations.ts`
- Create: `pc-server/api/task-schedules.test.ts`
- Modify: `pc-server/server.ts`（启动 scheduler）
- Modify: `pc-server/shutdown.ts`（停止 scheduler）
- Modify: `web-ui/app/components/settings/experiments/agent-bot.tsx`
- Create: `web-ui/app/components/workspace/agent-run-schedules.tsx`
- Create: `web-ui/app/tests/agent-run-schedules.test.tsx`

**Interfaces:**
- Consumes: Task 1/2 的 `scheduleId`、队列、生成入口、启动收敛。
- Produces: `AgentTaskScheduler.start()/stop()/tick(now)`、schedule CRUD、`scheduled` 消息注解、`schedulingEnabled` 设置。

- [x] **Step 1: 写调度契约失败测试**

覆盖：once 到期只跑一次、interval 最小/最大边界、catch_up_once 只补一次、skip 跳过、忙会话不堆队列、禁用不触发、删除会话级联、重复 tick 不重复领取。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test agent-loop/scheduler.test.ts api/task-schedules.test.ts`
Expected: FAIL，调度模块与路由不存在。

- [x] **Step 3: 实现表、CRUD 与事务领取**

按 §4 实现；所有 next_run_at 计算集中在 `nextScheduleTime(schedule, now)` 纯函数，路由与 tick 共用，禁止两套时间算法。

- [x] **Step 4: 接消息队列、run 链接与进程启停**

队列支持 `scheduled` 注解；生成时写 `schedule_id` 并回写 `last_run_*`；scheduler 在启动收敛后 start，在优雅停机 stop，定时器 unref。

- [x] **Step 5: 接设置开关与会话调度 UI，再跑目标回归**

提供新建/启停/删除与下次运行时间；关闭 schedulingEnabled 只停止投递不删记录。
Run: `bun test agent-loop/scheduler.test.ts api/task-schedules.test.ts agent-loop/acceptance.test.ts`
Run: `bun run typecheck`
Expected: PASS，无真实等待、无真实 Provider。

### Task 4: 全局审计查询、JSONL 导出与界面

**Files:**
- Create: `pc-server/api/handlers/agent-runs.ts`
- Create: `pc-server/api/agent-run-audit.test.ts`
- Modify: `pc-server/api/router.ts`
- Modify: `pc-server/agent-loop/run-store.ts`
- Modify: `pc-server/agent-loop/types.ts`
- Modify: `pc-server/api/handlers/conversations.ts`
- Create: `web-ui/app/components/settings/experiments/agent-bot-audit.tsx`
- Create: `web-ui/app/tests/agent-run-audit.test.tsx`
- Modify: `web-ui/app/components/settings/experiments/agent-bot.tsx`
- Modify: `web-ui/app/locales/{zh-CN,en-US}/common.json`

**Interfaces:**
- Consumes: 现有 run/event/projection、Task 1–3 的链接字段。
- Produces: `AgentRunAuditQuery`、`listAgentRunsForAudit(query)`、`GET /api/agent-runs`、单 run JSONL export。

- [x] **Step 1: 写审计 API 失败测试**

覆盖：状态/引擎/会话/调度筛选、稳定分页、非法游标 400、跨会话 404、导出首行 run + seq 升序事件、无正文/密钥、空结果形状。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test api/agent-run-audit.test.ts`
Expected: FAIL，路由与查询函数不存在。

- [x] **Step 3: 实现有界 SQL 查询与流式导出**

查询集中在 run-store；限制 1–100，固定排序；导出逐页读取事件并写 JSONL，避免一次性拼接超大字符串，沿用现有 payload 脱敏。

- [x] **Step 4: 实现审计列表与详情跳转**

筛选状态/引擎/会话，展示目标、状态、轮次、起止时间、恢复/调度链接；详情跳现有会话 run，导出使用浏览器下载，不在前端重新拼装审计内容。

- [x] **Step 5: 跑最终回归并回填验收证据**

Run（后端）: `bun test api/agent-run-audit.test.ts agent-loop/run-store.test.ts agent-loop/run-recovery.test.ts agent-loop/scheduler.test.ts agent-loop/plan-projection.test.ts`
Run（前端）: `bun test app/tests/agent-run-audit.test.tsx app/tests/agent-run-history-store.test.ts`
Run: 两端 `bun run typecheck`
Expected: PASS；只有已记录的 Windows EPERM/EBUSY flake 才可豁免。

## 完成定义

- 重启后不再出现永久 `running` 的孤儿 run；收敛幂等、事件可审计，suspended 不被误杀。
- 用户能把可恢复的中断任务显式续成新 run，旧 run 不变、链接可查、计划仍可读、无工具自动重放。
- once 与 fixed_interval 在重启后仍按 misfire 规则工作，不重复投递、不无限排队，run 能反查 schedule。
- 能跨会话筛选保留 run 并导出脱敏 JSONL，审批/边界详情沿用现有投影。
- 默认关闭时不产生恢复/调度/审计写入行为；安卓导出继续剥离 PC 专属设置。
- 两端 typecheck 与目标测试通过，未引入 cron、分布式调度、自动审批或不可篡改审计的虚假承诺。

## 实施记录（2026-11-03）

### 交付物

| 段 | 新增/修改 | 说明 |
| --- | --- | --- |
| L1 | `agent-loop/run-recovery.ts`、`schema.ts`、`run-store.ts`、`types.ts`、`bootstrap.ts` | `reconcileAgentRunsAfterBoot` 启动收敛 running→stopped/interrupted（事务内更新 + 只写一次 `reason=process_restart` 事件）；`getRunCheckpoint`；`getRunRecovery`；`resumed_from_run_id` / `schedule_id` 幂等 migration |
| L2 | `api/handlers/conversations.ts`（GET recovery / POST resume）、`tools/plan-context.ts`、`agent-loop/plan-projection.ts`、`agent-loop/run-tracker.ts`、`conversations/orchestrator.ts`、`backup/export.ts`、`web-ui` 运行面板 | `run_resume` 注解不切计划边界（`latestPlan` / `findPlanContext` / `isTaskBoundary` 三处同口径）；`runResumeTarget` 把旧 run id 写入新 run；恢复按钮仅在服务端判定 `new_run` 时出现 |
| L3 | `agent-loop/schedule-store.ts`、`agent-loop/scheduler.ts`、`conversations/message-queue.ts`、`conversations/orchestrator.ts`、`conversations/helpers.ts`、`server.ts`、`bootstrap.ts`、`agent-loop-config.ts`、`web-ui` 定时任务条与设置开关 | 表 `pc_task_schedule`；`nextScheduleTime` 单一时序算法；CAS 领取；忙会话 catch_up 退避 60s / skip 前进；投递带 `scheduled` 注解；`markScheduleRun` 回写 last_run_*；删除会话显式清调度 |
| L4 | `api/handlers/agent-runs.ts`、`api/router.ts`、`run-store.ts`（审计查询 + 顺序读）、`web-ui` AgentBot 审计区 | `GET /api/agent-runs` 跨会话筛选 + 复合游标分页；`GET .../agent-runs/:runId/export` 流式 NDJSON（run → events 升序 → projection）；不提供删除/清审计 |

### 与计划的偏差（均为实现约束，非范围变更）

1. **DTO 落在 `agent-loop/types.ts` 而非 `run-recovery.ts`**：web-ui 只能 import 无 `bun:sqlite` 运行时依赖的模块；`run-recovery.ts` 仍转出这些类型，保持能力入口不变。
2. **调度拆成 `schedule-store.ts` + `scheduler.ts`**：`orchestrator` 需要回写 `last_run_*`，若直接依赖含投递逻辑的 `scheduler` 会形成 `orchestrator ↔ scheduler` 环。store 只碰 DB 与时间，tick 只碰投递。
3. **恢复入口只对"最近一条 run"开放**：历史 run 在面板中保持只读。恢复语义是"接着当前任务跑"，历史任务之后可能已发布新计划，沿用旧计划会落到错误目标；服务端判定不变，仍可被 API 单独调用。
4. **审计游标增加可选 `beforeId`**：仅 `started_at <` 会在同毫秒记录的页边界跳过行；`(started_at, id)` 复合比较保证不重不漏，响应同时返回两个游标字段。

### 耦合检查（2026-11-03，真进程 debug）

新增 `pc-server/scripts/smoke-task-lifecycle.ts`（`bun run smoke:task-lifecycle`）：临时数据目录 + 本地假 LLM + 真实 server 子进程，22 项断言覆盖 L1–L4 的模块耦合：

- **启动顺序**：loadState 开库建表 → working set → 启动收敛 → 调度启动；收敛在 `scheduler.start` 之前，遗留 running 不可能先被调度读到。
- **调度链路**：schedule-store(CAS 领取) → message-queue(annotations) → dispatchMessageQueue → generateAnswer → beginAgentRun(schedule_id) → markScheduleRun(last_run_*)，全链路真落库；投递消息带 `scheduled` 注解。
- **恢复链路**：GET recovery → POST resume(202) → `run_resume` 消息 → 新 run 写 `resumed_from_run_id`，旧 run 终局不被改写。
- **审计链路**：跨会话筛选、空结果形状、NDJSON 三段（run → events 升序 → projection）、content-type。
- **停机与重启幂等**：HTTP 优雅停机释放数据目录锁；二次启动无 running、`process_restart` 事件不重复。

耦合检查中发现并修复的两处：

1. `resetConversationsDbTo`（备份全量导入）只重灌会话，会留下指向已不存在会话的孤儿调度。已在同一事务内按 `conversation_id NOT IN (SELECT id FROM pc_conversation)` 清理；运行记录不清理（审计证据）。
2. `GET .../recovery` 在总开关关闭时仍返回 `new_run`，而 POST 会 409——前端会显示一个点了必失败的恢复按钮。现改为：开关关闭时判定直接返回 `none / feature_disabled`，判定与写入同口径。

平台行为（记录，不改）：Windows 上 SIGTERM 不保证进入信号处理器，数据目录锁可能残留到下次启动由 PID 存活检测接管；壳的真实停机路径是 `POST /api/app/shutdown`，冒烟脚本也走该端点。硬杀后最多丢失一个调度周期（先领取后投递），运行记录由启动收敛如实收成 interrupted。

### 遗留与已知边界

- `pc-server` 的 `run-recovery.ts` 在 `getRunCheckpoint` 中做计划投影以回答 `planAvailable`，投影失败按 false 降级，不阻塞恢复判定。
- 调度 tick 固定 15s；`SCHEDULE_TICK_MS` 未做成设置项。进程停机期间错过的周期由 misfire 策略统一处理（catch_up_once 最多补一次）。
- 审计只覆盖保留窗口内（每会话最近 20 条）的记录，UI 已明示；跨窗口查询需要调大保留条数，本期未做。
