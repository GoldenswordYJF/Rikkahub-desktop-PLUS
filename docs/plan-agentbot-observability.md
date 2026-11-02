# AgentBot 多步任务可观测性计划与流程规范

> 状态：O1–O5 已完成（历史读取/分页、时间线与历史回看、计划证据链、权限边界复盘、mock 验收与文档）。
> 进度：O1 ✅ · O2 ✅ · O3 ✅ · O4 ✅ · O5 ✅；验收证据与遗留限制见 §10。
> 范围：任务状态、步骤日志、计划与工具证据关联、权限边界复盘、历史运行回看。
> 前置：`docs/plan-autonomous-loop.md`（S1–S5 已完成）、`docs/dev-workflow.md`（通用开发纪律）。
> 约束：复用现有 run/event、计划 v2 与消息工具卡；不新做执行器，不改 `pi/` vendor，不调用真实计费供应商。

## 0. 一句话结论

现有 AgentBot 已经能记录“最近一次运行发生了什么”，但还不能可靠回答“历史某次运行走到哪一步、每个结果由哪次工具调用证明、当时按什么权限边界执行”。本计划只做一层**只读观测与关联投影**：

1. 把现有每会话 20 条 run 变成可回看、可分页读取的历史记录。
2. 用已有 `runId / step.id / toolCallId / planV2` 把计划步骤、运行事件和消息工具卡连起来。
3. 在权限判定与工具执行单点补充结构化边界快照，让审批与执行可以按当时语境复盘。

不新增任务中心页面，不改变自主循环、审批、重试或权限判定语义，不把完整工具输入输出复制进运行日志。

## 1. 现状与证据

| 能力 | 已有基础 | 当前缺口 |
| --- | --- | --- |
| 运行记录 | `pc_generation_run` / `pc_generation_run_event` 已落 SQLite，每会话保留 20 条 run；事件有单调 `seq`、摘要和小载荷（`pc-server/agent-loop/schema.ts:12-47`、`run-store.ts:185-212`） | API 与前端只暴露最新 run；历史 19 条实际不可见 |
| 实时状态 | run tracker 观察工具、审批、重试、replan、停滞与终局；SSE 首帧给快照，后续按事件增量推送（`run-tracker.ts:97-195`、`api/sse.ts:252-256`） | 首帧事件最多 300 条且没有补拉游标；长运行无法完整回看 |
| 运行面板 | 输入区上方已有折叠面板，展示状态、轮次、工具数、重试、replan、终局和事件摘要（`web-ui/app/components/workspace/agent-run-panel.tsx:129-198,201-287`） | 无历史切换、事件筛选、分页、toolCallId 定位；`phase/goal/stallReason` 等已有字段未展示 |
| 计划 v2 | 步骤已有 `id / verify / evidence / attempts / lastError`，`evidence` 就是 toolCallId 列表（`pc-server/tools/plan.ts:53-76`） | 面板只用 evidence 判断“未验证”，不展示证据，也不能跳到工具卡或运行事件 |
| 计划恢复 | 前端能从当前消息分支重放最新权威 `planV2`（`web-ui/app/lib/plan-model.ts:22-62`） | 只有最新计划；历史 run 不能拿当前计划冒充当时计划 |
| 工具详情 | 消息时间线工具卡已保存并展示命令、路径、diff、exit code、错误与审批操作 | 与 run 面板、计划步骤是三个分离视图，没有共同定位入口 |
| 权限判定 | 已有权限档、root/cwd、严界/宽界、危险命令判定和沙盒实测状态；最终审批判定在 `pc-server/tools/approval.ts`，执行保护与有效写边界在 `workspace/runtime.ts`，沙盒实测在 `workspace/sandbox.ts` | 这些信息只在判定/执行当下存在；run 不保存“当时边界”，审批缘由也未完整结构化 |
| 中断与刷新 | 最新 run 可由 SSE 首帧恢复；suspended run 审批后可接续（`run-tracker.ts:273-325`） | 只是观测状态恢复，不是跨重启执行恢复；历史 run 与面板选择不恢复 |

结论：不需要再建一套事件总线或任务数据库。主要工作是**补读取契约、补关联、补执行语境、补展示**。

## 2. 目标与非目标

### 2.1 用户必须能回答的问题

- 这次任务现在是运行、等待审批、等待人工判断，还是已经终结？当前相位和终局原因是什么？
- 已经执行了哪些步骤和工具？哪一步正在重试、重规划、停滞或失败？
- 某个计划步骤标记完成，是由哪些 toolCallId 证明的？能否直接定位原工具卡？
- 某次审批为什么出现，用户批准或拒绝了什么？当时的工作区、权限档、有效写边界和系统沙盒是什么？
- 刷新页面后，能否继续看最新运行？能否回看本会话保留下来的历史运行而不被实时事件覆盖？

### 2.2 本期不做

- 不做跨重启执行恢复、cron 调度、DAG 任务图、分布式 worker。
- 不做独立“任务中心”或跨会话全局监控页。
- 不做不可篡改安全审计、外部 telemetry、OpenTelemetry 服务或云端上传。
- 不在运行日志复制模型正文、完整命令、完整工具参数或工具输出；这些仍留在原消息工具卡。
- 不做运行日志分享/导出文件；先完成可读、可定位、可分页，导出另行评估。
- 不为观测新增第二套权限判断，也不让观测面板直接批准、提权或修改工作区。

## 3. 总体模型与不可让渡的不变量

### 3.1 关联模型

```text
Run(runId)
├─ Summary：status / phase / rounds / attempts / replanCount / 起止时间 / 终局原因
├─ Event(seq, kind, at, summary, payload)
│  ├─ toolCallId?：定位消息时间线里的原工具卡
│  └─ boundaryUse?：{ boundaryId, stage, access, targetScope }
├─ PlanProjection：服务端按 run 边界与权威 toolCallId 还原，不依赖已加载事件页
│  └─ Step(step.id)
│     └─ evidence[] = toolCallId[]：步骤完成的唯一机器关联
└─ BoundaryProjection：服务端按 run 汇总不可变快照，不依赖已加载事件页
   └─ BoundarySnapshot(boundaryId)
      └─ workspace / permission / effectiveWriteScope / sandbox
```

关联纪律：

- 只用显式 id 关联，不按工具名称、文本相似度、发生顺序猜测步骤归属。
- 没有 `step.evidence` 的工具事件归入“运行级事件”，不硬塞给某一步。
- 已加载的一页事件不等于完整 run。历史计划与 boundaryId 定义必须由服务端 run 级投影提供，不能只在当前事件页里查找，也不能要求用户先“加载更早”才能看懂最新页。
- 历史计划优先取该 run 内最后一次 `update_plan` 的 toolCallId，并在该会话消息中按此**全局唯一 id 精确查找**权威 `planV2`，不受当前分支和事件分页影响。
- run 内没有计划变更时，才允许以 `run.nodeId` 为锚点，在锚点所属分支的本次任务边界内向前找最近权威快照；搜索到最近的前置非 steering USER/run 边界即停止，不跨上一项用户任务，不搜索非选中分支。锚点、分支或任务边界无法唯一确定时显示“当时计划快照不可用”，禁止用当前最新计划冒充。
- 消息或工具卡已被删除时保留 run 事件，但定位入口显示不可用，不伪造详情。
- `BoundarySnapshot` 的可复用身份只包含工作区、权限档、有效写边界和系统沙盒；`stage/access/targetScope` 是每次调用的使用语境，放在引用事件上，不参与快照去重。

### 3.2 数据与兼容不变量

- run 摘要可更新，run 事件追加后不可改；`seq` 仍由 SQLite 写入方分配。工具执行语境通过后续事件补充，不回写已经追加的 `tool_call`。
- 每会话 20 条 run 的保留策略不变；事件读取改成分页，不靠静默截断伪装完整。
- run 列表、latest 查询与保留淘汰统一采用确定顺序 `startedAt DESC, id DESC`；相同时间戳下不得因 SQLite 返回顺序不同而选中不同 run。
- 复用现有两张表和通用 `payload`，本期预计不需要新表；若实现中发现必须加列，只能 additive migration，并先补旧库升级测试。
- 现有 `GET conversations/:id/agent-run` 与 `agent-run` SSE 帧保留，响应只新增可选字段，不删除或改变旧字段含义。
- DTO 兼容不等于旧面板能渲染未知事件。当前前端必须先为未知 `kind` 提供通用图标、标签与安全摘要兜底，后端才可新增 `boundary/tool_execution` 等 kind；升级前已经打开的旧页面不承诺识别新 kind，需刷新获取新前端。
- `agentLoop.enabled=false` 时不新增运行写入，现有生成、审批、重试路径逐字保持一致；历史已存在数据可以只读查看，但不能因此启动观测写入。
- 记录继续 best-effort：落库或推送失败只能降低可见性，不能影响生成与工具执行。

### 3.3 隐私与体积不变量

- 新增事件只存 id、状态、计数、权限元数据和短摘要；不新增模型正文、完整命令、工具参数、工具输出正文。
- 权限快照可保存工作区 id/type、root、cwd、本地/SSH、权限档、有效写边界和沙盒状态；具体命令与目标路径仍通过 toolCallId 到消息卡查看。
- 现有 `approvalState.reason` 可能含完整解析路径，不得原样复制到 run。审批载荷只存白名单 `reasonCode`、危险规则 id 和去路径化短缘由；用户填写的拒绝理由可截断保存，完整审批语境仍看原审批卡。
- `summary` 继续限制 240 字符；新增结构化载荷必须有大小上限与字段白名单，不能整包序列化 runtime 或 settings。
- PC 自有表继续不进入安卓导出白名单；本期不新增设置字段，因此无需新增设置迁移或导出开关。

## 4. 分阶段实施

阶段必须按 O1 → O5 顺序完成。每个阶段都要能独立演示、独立回归；上一阶段测试未通过，不进入下一阶段。

| 阶段 | 交付结果 | 主要改动面 | 完成门槛 |
| --- | --- | --- | --- |
| O1 历史读取与事件分页 | 可列出保留的 run；任意 run 可按游标读取完整事件；旧快照/SSE 字段兼容；未知事件可降级展示 | `agent-loop/run-store.ts`、`agent-loop/types.ts`、`api/handlers/conversations.ts`、web-ui DTO 与事件渲染兜底 | 多 run、相同时间戳、长事件流、重复/乱序增量测试通过 |
| O2 运行时间线与历史回看 | 现有折叠面板可切换历史 run、查看相位/目标/终局、筛选事件、加载更早事件；选择状态与同一会话窗格共享 | `agent-run-panel.tsx`、会话窗格级 selection provider、运行读取 hook/model、`conversation-store.ts` 仅做必要适配 | 实时 run 与历史 run 不互相覆盖；重连、竞态、新 run 与跨窗格隔离测试通过；刷新恢复最新 run |
| O3 计划—步骤—工具证据链 | 步骤显示验证方式、错误和证据；证据与工具事件可定位消息卡；服务端 run 级投影还原当时计划 | `plan-model.ts`、`plan-panel.tsx`、`agent-run-panel.tsx`、run 计划投影与消息定位逻辑 | 未加载旧页也能取快照；明示 evidence 可互跳；无证据/无快照/跨任务时不猜测 |
| O4 权限边界与审批复盘 | 审批与执行事件分别关联当时边界；权限变化产生新快照；面板可查看当时边界 | `tools/approval.ts`、`workspace/runtime.ts`、新增观测适配模块、run tracker、审批/运行面板 | 不改变审批结果；审批/执行语境不混淆；旧页中的 boundaryId 也能解析 |
| O5 mock 验收与文档 | 双引擎关键路径、分页/刷新/权限/移动端验收完成，计划状态与发布条目更新 | 目标测试、demo mock、本文档 | 零计费、目标测试绿、typecheck 绿、截图取证完成 |

### 4.1 O1：历史读取与事件分页

后端：

- 新增 `listRuns(conversationId)`，按 `startedAt DESC, id DESC` 返回保留的 run 摘要，不携带事件，避免列表响应随事件数膨胀；`latestRun` 与保留淘汰使用同一排序规则。
- 新增按 run 读取事件的游标接口：`beforeSeq + limit`，语义为严格 `seq < beforeSeq`，页内仍按 `seq ASC` 返回；不带游标时返回**最新一页**，并给出 `hasMore / nextBeforeSeq / throughSeq`。其中 `nextBeforeSeq` 是本页最小 seq，`throughSeq` 是本次快照已覆盖的最大 seq；客户端翻页仍以当前缓存最小 seq 重新计算游标。
- 现有 `getRunSnapshot` 从“前 300 条”改为“最新一页 + 窗口信息”，响应只新增可选字段；不得再让长运行的末尾事件在刷新后消失。
- 新增只读路由，建议：
  - `GET /api/conversations/:id/agent-runs`
  - `GET /api/conversations/:id/agent-runs/:runId/events?beforeSeq=&limit=`
- 路由必须校验 run 属于该 conversation，不能凭 runId 跨会话读取；具体路由注册放在通用 `conversations/:id/*` 匹配之前。
- `limit` 由服务端钳制，建议默认 200、最大 300；非法 cursor 返回 400，非法 limit 钳制或 400 的规则在契约测试中固定。SSE 仍只推增量，不为新事件重复发送全量历史。
- O1 同步给现有事件渲染增加未知 `kind` 的安全兜底；后续新增 kind 不需要再改旧字段，也不能让单个未知事件使面板崩溃。

测试：20 条保留上限、相同 startedAt 的列表/latest/淘汰顺序、跨会话 404/空结果、最新页与向前翻页、页边界无重复无缺口、非法 cursor/limit、旧快照字段兼容、未知 kind 降级、开关关闭无新写入。

### 4.2 O2：运行时间线与历史回看

前端：

- 保留输入区上方的现有折叠面板，默认仍收起；不增加新导航页面。
- 面板标题区补当前相位、目标短摘要、持续时间和终局原因；历史 run 用下拉或紧凑切换器选择，默认“最新运行”。
- 在**会话窗格根部**增加 selection provider，状态为 `{ mode: "latest" }` 或 `{ mode: "history", runId }`，供该窗格的 AgentRunPanel 与 PlanPanel 共同读取。选择状态不能放在面板局部，也不能写入全局唯一 latest-run 槽；两个会话窗格互不污染，刷新后回到 latest。
- 事件区提供“全部 / 工具 / 审批 / 重试与重规划 / 异常”筛选；筛选只改变视图，不改服务端事件顺序。
- “加载更早”每次以该 run **当前已加载最小 seq** 作为 `beforeSeq`，不能复用可能因缓存淘汰而过期的 `nextBeforeSeq`；响应按 `(runId, seq)` upsert 去重并排序，不能按到达顺序拼接。
- 新到 SSE 事件只并入 latest run 的实时缓存。选中历史 run 时，实时最新运行可在标题显示提示，但不能篡改历史事件列表；历史选中期间出现新 run，仍保持原选择并显示“有新运行”，切回 latest 才跟随。
- 首帧之后若 latest 增量 seq 与当前实时尾部不连续，标记窗口失配并重新 GET 最新快照，不在客户端编造缺失事件。断线重连以新首帧替换 latest 实时窗口、作废旧分页请求并清除 latest 的更早页；历史 run 的选中状态保留，但其数据按独立 GET 重新校验。
- 所有 GET 带 runId、选择代次和请求序号；响应到达时若 run、选择或重连代次已变化则丢弃，禁止较慢的旧响应覆盖新页面。
- latest-run 后台缓存可保留固定窗口，但必须同步更新 `hasMore` 与最小 seq，淘汰后允许重新向前补页；当前选中 run 已加载的页不得再被 500 条静默截断。离开窗格或切换历史缓存时按 run 整体淘汰，不在所有会话长期保存完整事件流。
- 工具/审批事件显示短 toolCallId，并提供“定位消息”入口；点击后复用现有消息聚焦/滚动机制，不复制一份工具详情。
- 保留 stalled/exhausted 的“继续 / 改目标”入口，但只允许对可接续的最新 run 操作；历史终局 run 只读。
- 窄窗格与移动端沿用现有全宽折叠布局；筛选项允许换行，不用横向滚动表格。

数据纪律：现有 `conversation-store` 继续只承担 latest-run SSE 摘要与实时窗口；历史列表、各 run 分页和竞态控制放在独立读取 hook/model，选择状态由会话窗格 provider 共享，避免把多套 run 事件塞进每会话唯一的实时槽位。

### 4.3 O3：计划—步骤—工具证据链

- 从 `plan-model.ts` 抽出“单个 update_plan tool part → 权威 Plan”的纯函数，供最新计划与历史 run 复用，不维护两套解析规则。
- 新增 `GET /api/conversations/:id/agent-runs/:runId/projection` 作为 run 级只读投影路由；O3 先在响应中加入 `plan: { plan / sourceToolCallId / unavailableReason }`，O4 再加 `boundaries`。路由同样校验 run 属于该 conversation。
- 计划投影直接查询该 run 全部 `update_plan` 事件及相关消息，不依赖前端当前加载页；`unavailableReason` 让“无计划”和“证据丢失”可区分。
- `PlanPanel` 从会话窗格 selection provider 读取同一选中 run：latest 显示最新计划投影，history 显示该 run 的历史投影；不得另选一个 run，也不得读取其他窗格的选择。
- `PlanPanel` 每一步补充：
  - `verify`：如何验证；
  - `attempts` 与 `lastError`：已有则显示；
  - evidence 列表：短 toolCallId + 定位入口；
  - completed 但 evidence 为空时继续显示“未验证”，且不生成假链接。
- run 面板的工具事件与 PlanPanel 的证据 chip 使用同一套消息定位函数；定位目标是对应 toolCallId 的消息工具卡，而不是只滚到消息顶部。
- 历史 run 的计划解析顺序：
  1. 在该 run **全部事件**中取最后一次 `update_plan` 的 toolCallId，再于该会话消息中按精确 id 找权威 `planV2`；即使事件在尚未加载的旧页、工具 part 不在当前分支，也能还原来源，但定位入口须如实显示消息卡是否仍可见。
  2. 若该 run 没有计划变更，才在 `run.nodeId` 所属分支的本次任务边界内向前找最近权威快照；遇到最近的前置非 steering USER/run 边界即停止。新 USER 任务自己没有计划时返回不可用，不能捡上一任务的计划。
  3. 锚点、分支、边界或来源无法唯一确定时明确显示不可用；不搜索非选中分支，不按时间或文本相似度猜测。
- 不按数组下标把工具事件分配给步骤；step.id 与 toolCallId 的关联只认 `evidence`。
- 计划原始 JSON、工具完整输入输出继续默认折叠；本阶段只把“结果与证据”就地展示。

### 4.4 O4：权限边界与审批复盘

新增内部观测契约，不修改模型可见工具 schema：

```jsonc
// boundary 事件：run 内可复用、不可变的稳定快照
{
  "boundaryId": "b3",
  "workspace": { "id": "…", "type": "local | ssh", "root": "…", "cwd": "…" },
  "permissionPreset": "confirm_each | balanced | full_access",
  "effectiveWriteScope": "strict | wide",
  "sandbox": {
    "tier": "off | restricted | full",
    "measured": "enforced | not_enforced | unknown",
    "boundaryActive": true,
    "mechanism": "…",
    "checkedAt": 0
  }
}

// approval / tool_execution 事件：一次调用的使用语境
{
  "toolCallId": "…",
  "boundaryId": "b3",
  "stage": "approval | execution",
  "access": "read | write | execute",
  "targetScope": "inside | outside | unknown"
}
```

实施规则：

- 在 `pc-server/tools/approval.ts` 的最终审批判定与 `workspace/runtime.ts` 的执行保护/有效写边界单点分别挂载可选 observer；编排层把 observer 适配到当前 run tracker。不要新建全局事件总线，也不要让 tools/workspace 层反向依赖 API/SSE。
- 同一 run 内按稳定快照字段的规范化值去重并复用 boundaryId；`stage/access/targetScope` 不参与去重。权限档、root/cwd、有效写边界或系统边界变化时才产生新 `boundary` 事件，引用事件只带 boundaryId 与本次使用语境。
- 在上述 run projection 路由的 `boundaries` 字段中，从该 run 全部 `boundary` 事件构建 `{ [boundaryId]: snapshot }`；面板解析引用时读取此投影，不依赖当前事件页是否包含定义事件。
- `stage=approval` 与 `stage=execution` 分开记录。现有 `tool_call` 在执行前已追加且不可修改；实际执行前另追加 `tool_execution` 记录执行时 boundaryId，不回写旧 `tool_call`，也不把审批时快照冒充执行时快照。
- pending 审批补充白名单 `reasonCode`、去路径化短缘由与危险规则 id；现有字符串 `approvalState.reason` 保留，模型与旧 UI 行为不变，完整路径不复制进 run。
- 批准/拒绝记录决定、短理由、时间和审批时 boundaryId。审批 API 已记录决定后，后续 `tool_approval_updated` 不得再次追加同一决定；按 `(runId, toolCallId, decision)` 或现有决定 id 幂等去重，每个决定只计数一次。
- `full_access` 只表示应用权限档；系统沙盒 `boundaryActive=true` 时必须同时醒目标示，不能显示成“无边界”。
- 观测面板不提供审批按钮；pending 事件只链接到原审批卡，批准/拒绝仍走现有端点与权限路径。
- 只读工具可记录边界引用，但同一快照只在首次出现或变化时写事件，防止把运行流水刷成权限日志。

测试重点：三档权限、区内外写入、危险命令、拒绝理由与路径脱敏、审批双通路去重、沙盒 enforced/not_enforced、full_access 与系统边界叠加、run 中途权限收窄、本地与 SSH、边界定义位于未加载旧页、observer 抛错不影响执行。

### 4.5 O5：验收与交付

- 后端目标测试：run store、run tracker、conversation routes、最终 approval/runtime 观察点、run 级计划与边界投影、相关双引擎工具通路。
- 前端目标测试：run 历史读取与分页、latest/selected 与窗格隔离、SSE 去重与缺口重同步、重连和 GET 竞态、未知 kind、计划快照选择、证据定位、权限展示投影。
- 运行 `web-ui` 与 `pc-server` typecheck；新增或修改测试必须实际执行并迭代到通过。
- 全部动态验收使用脚本化 provider / 本地 mock（`127.0.0.2:18124`，状态端点 `/__state`），不打真实供应商，不产生付费请求。
- 前端 build 后通过 `demo-profiles/tools/demo-server.sh` 重启 17455；截图覆盖实时、历史、长日志、审批、权限变化、窄窗格。
- 更新本文档状态与 `docs/plan-autonomous-loop.md` 的关联说明；发布说明只写短变更条目。

## 5. 事件与接口规范

### 5.1 事件契约

- `kind` 只能新增，不重命名、不复用旧 kind 表达新含义；payload 字段只增不改不删。所有前端事件入口必须先处理未知 kind，再消费已知 kind。
- `summary` 是给人看的短文案，`payload` 是程序关联依据；前端不得解析 summary 获取 toolCallId、状态或权限信息。
- `at` 统一 epoch milliseconds；`seq` 是同一 run 内唯一且单调的排序依据，不用客户端时间重排事件。
- 终局只写一次 `run_finished`；`succeeded/failed/exhausted/stalled/stopped` 不回退成 running。suspended 的审批续跑沿用同一 run，并写 `run_resumed`。
- `round` 表示模型轮次，传输重试不增加 round；重试次数只看 attempts/retry 事件。
- 同一审批决定只写一次；后续状态同步不能重复增加审批计数。执行语境只能新增 `tool_execution`，不能修改既有 `tool_call`。
- 观测事件不携带可执行指令，前端一律按不可信数据渲染，不把 payload 当 HTML/Markdown 注入。

### 5.2 实时与历史读取

- SSE 负责“最新 run 的增量变化”；GET 负责“首屏补偿、历史 run、更早事件、run 级计划/边界投影”。
- 首帧带最新事件窗口，增量帧按 `(runId, seq)` upsert 去重；客户端始终以 seq 排序，不以网络到达顺序排序。
- 向前翻页的游标取当前已加载最小 seq；每页独立合并。缓存淘汰后必须重算游标和 hasMore，不能继续使用旧 nextBeforeSeq，也不能把不连续区间显示成完整历史。
- latest 实时尾部出现 seq 空洞时重新拉最新快照；断线重连后以新首帧重新对齐，作废旧响应和 latest 更早页，不靠客户端猜测缺了哪些事件。
- 选中历史 run 后，latest-run SSE 仍可在后台更新摘要，但不得覆盖历史选中项；历史选中期间的新 run 只产生提示，不自动切换。
- GET 只接受仍属于当前 run、当前选择代次和当前重连代次的响应；慢响应、旧 run 响应和旧快照一律丢弃。
- 计划与 boundary 定义是 run 级读取，不依赖事件页。事件列表始终服务端分页；禁止为了“看完整”一次性把全部事件塞回首帧或长期保存在所有会话的内存里。

### 5.3 权限观测

- 观测只能记录权威判定的结果，不能在 UI 或 tracker 再实现一套权限矩阵。
- 审批时快照与执行时快照分别标注；不允许把后来变化后的权限档回填到旧工具事件。
- 不新增自动批准、超时批准、失败提权、拒绝后自动重试。
- 系统沙盒实测状态优先于宣传文案；`unknown/not_enforced` 必须如实显示。

## 6. 开发与验收流程规范

每个 O 阶段均按以下顺序走，不跳步：

1. **锁定基线**：完整阅读本阶段涉及文件与现有测试，记录当前 API 形状、默认关闭行为和 Windows 已知测试基线。
2. **先写契约测试**：先钉住兼容、排序、关联和权限不变化，再实现；不得为迁就新 UI 改旧事件语义。
3. **后端单点实现**：优先复用 run tracker、最终 approval/runtime 判定与现有消息 toolCallId；不新建平行记录链路。
4. **前端投影实现**：服务端数据到视图模型用纯函数完成，组件只负责展示与交互；关联失败必须显式降级。
5. **目标回归**：先跑本阶段测试，再跑共享事件/工具通路测试与两端 typecheck；未触碰文件的并行会话错误只报告，不顺手改。
6. **mock 实机验收**：使用本地假 provider 制造多轮、多工具、审批、失败、重试、长日志；截图核对实际页面，不只看测试。
7. **重建与收口**：web-ui build 后经 `demo-server.sh` 重启 demo；检查 `/api/health`，不留脚本直起的孤儿后端。
8. **更新状态**：记录已完成项、证据与遗留限制，再进入下一阶段；发布说明最后单独给短版。

通用纪律继续按 `docs/dev-workflow.md`：不改 `pi/` vendor；PC 设置与 SQL 不混写；不删除历史数据；不擅自提交；测试工作区与截图产物清理前先列清单并询问。

## 7. 总验收用例

| # | 场景 | 必须看到的结果 |
| --- | --- | --- |
| 1 | 同一会话连续完成 3 次运行，其中两条 startedAt 相同 | 可切换 3 条 run，状态、目标、起止时间和事件各自独立；列表/latest/淘汰均按 `startedAt DESC, id DESC` 稳定排序 |
| 2 | 一次运行产生超过单页上限的事件 | 刷新后看到最新页，可逐页加载更早；无重复、无缺口、无假“完整” |
| 3 | 首帧之后又收到超过 500 条 SSE 事件 | 最新事件可见，重复 seq 被去重；若实时窗口淘汰旧事件，游标与 hasMore 同步重算，可重新补页，不显示伪连续历史 |
| 4 | 查看最新 run 时收到 SSE，再切到历史 run | 增量只进入最新 run；历史列表不被覆盖 |
| 5 | 已加载多个更早页后断线重连 | latest 以新首帧对齐，旧分页响应失效，更早页按需重拉；seq 无重复、无假补缺 |
| 6 | 正在看历史 run 时启动了新 run | 历史选中与事件保持不变，只显示“有新运行”；切回 latest 后才进入新 run |
| 7 | 历史页/快照 GET 乱序返回，或响应到达前切换 run | 旧 run、旧选择和旧重连代次的响应被丢弃，不覆盖当前视图 |
| 8 | 计划步骤 completed 且有 evidence | 步骤显示证据，点击定位到同 toolCallId 的工具卡；工具事件也能反向定位 |
| 9 | completed 无 evidence，或历史工具卡已不存在 | 显示未验证/详情不可用，不按名称或顺序猜测关联 |
| 10 | 历史 run 之后计划又多次修改 | 历史 run 显示当时快照，不用当前计划替代 |
| 11 | 某 run 最后一次 update_plan 位于尚未加载的旧事件页 | run 级计划投影仍返回正确快照和来源 toolCallId，无需先加载全部事件 |
| 12 | 新 USER 任务没有 update_plan，或锚点位于非当前选中分支 | 新任务显示计划不可用，不捡上一任务；非选中分支不被搜索或冒充来源 |
| 13 | 工具等待审批，随后拒绝并填写理由 | 看到 pending、拒绝、短理由和审批时边界；拒绝后不自动重试 |
| 14 | 审批 API 已记录决定，随后又收到 tool_approval_updated | 只保留一个决定、只计数一次，原审批卡状态仍正常 |
| 15 | balanced 区外写入、危险命令、confirm_each | 审批缘由与权限档一致；run 只存规则 id/去路径化短缘由，批准操作仍只在原审批卡 |
| 16 | 工具审批后、实际执行前权限语境变化 | 审批事件保留审批时快照，后续 tool_execution 记录执行时快照；旧 tool_call 不被回写 |
| 17 | run 中途权限档或工作目录变化 | 产生新 boundaryId；旧事件保留旧边界，新事件引用新边界 |
| 18 | boundary 定义事件位于尚未加载的旧页 | run 级边界投影仍能解析引用并展示快照，不显示成“无边界” |
| 19 | full_access 且系统沙盒仍 enforced | 同时展示应用权限与系统边界，不显示“完全无限制” |
| 20 | 用户 stop / replaced / deleted | 终局与 stopReason 正确，终局不被后续迟到事件复活 |
| 21 | observer 或运行记录写入失败 | 生成与工具执行结果不变，只是观测降级 |
| 22 | agentLoop.enabled=false | 不产生新观测写入；现有主链路行为与改动前一致 |
| 23 | 收到未来版本的事件 kind | 通用图标/标签与安全摘要正常展示，面板不崩溃，不解析 summary 获取结构信息 |
| 24 | 移动端/窄窗格查看长运行 | 面板可折叠、筛选可换行、事件可纵向滚动，无横向表格溢出 |
| 25 | 数据检查与安卓导出 | 新增事件无完整工具正文/命令/解析路径；PC run 表仍不进入安卓导出 |

## 8. 风险与控制

- **事件量与内存膨胀**：服务端游标分页、列表只带摘要、latest 与 history 分离、缓存按 run 整体淘汰，禁止全量重放或对所有会话长期保留完整事件。
- **分页与实时合并错乱**：seq upsert、当前最小 seq 游标、缺口重同步、重连代次和慢响应丢弃共同保证顺序；任何不连续区间都不得冒充完整历史。
- **历史计划错配**：run 内 update_plan 只认精确 toolCallId；fallback 仅限 run.nodeId 所属分支的本次 USER/run 任务边界，无法确定就显示不可用。
- **把一页误当完整 run**：计划和 boundary 均由服务端 run 级投影提供，UI 不从可见事件页推断缺失定义。
- **权限语境错配**：最终审批点与执行保护点分别观测，事件引用不可变 boundaryId；执行语境另写 tool_execution，不回填。
- **敏感信息进入日志**：字段白名单、载荷上限、审批缘由去路径化、正文留消息卡；实现后用数据库查询抽查，而不只 review TypeScript 类型。
- **观测影响主链路**：observer 可选且 best-effort，异常隔离；默认关闭路径必须回归。
- **双引擎漂移**：观测挂载在共享最终 approval/runtime 与现有 GenerationEvent 边界，pi 侧只在 `pc-server/pi-engine/*` 适配，不改 vendor。
- **范围蔓延成任务平台**：跨重启执行、调度、全局任务中心、不可篡改审计和导出均明确留到后续独立计划。

## 9. 完成定义（DoD）

只有同时满足以下条件，才能宣称“多步可观测性完成”：

- 最新与历史 run 都可读，长事件流可完整分页回看。
- 任务状态、相位、步骤、工具、审批、重试、终局在同一运行视图可理解地呈现。
- 计划步骤与工具证据通过真实 toolCallId 关联，未知关系不伪造。
- 每次需要权限判断的工具调用都能复盘当时边界，权限变化有明确记录。
- 默认关闭兼容、审批语义、权限判定、生成主链路均未改变。
- O1–O5 的测试、mock 实机截图、typecheck、demo 健康检查与文档状态全部完成。

## 10. 落地记录与验收证据（2026-11-01）

| 阶段 | 落地内容 | 主要证据 |
| --- | --- | --- |
| O1 | `GET /api/conversations/:id/agent-runs`、`/agent-runs/:runId/events?beforeSeq&limit`、`/agent-runs/:runId/projection`；事件按服务端游标分页，列表只带摘要 | `pc-server/api/agent-runs-routes.test.ts`、`pc-server/agent-loop/run-store.test.ts` |
| O2 | 会话窗格级 latest/history 选择；历史读取 hook 负责分页、竞态与重连代次；`agent-run` SSE 按 `(runId, seq)` 去重，缺口重新 GET 快照，历史选中不被 latest 覆盖 | `web-ui/app/tests/agent-run-history-store.test.ts`、`conversation-stream.test.ts`、`agent-run-event-list.test.tsx` |
| O3 | run 级计划投影（精确 `toolCallId` 选择当时快照）与 `toolLocations`；步骤证据/工具事件双向定位；未知关联显式降级 | `pc-server/agent-loop/plan-projection.test.ts`、`web-ui/app/tests/agent-run-event-list.test.tsx` |
| O4 | 最终审批点与执行保护点分别观测；`boundary` 定义按稳定字段去重、`tool_execution` 记录执行时 boundaryId；审批理由白名单与去路径化；决定按 `(runId, toolCallId, decision)` 幂等；`full_access` 与系统沙箱同时展示；面板不提供审批按钮 | `pc-server/agent-loop/run-boundary.test.ts`、`run-tracker.test.ts`、`workspace/runtime.test.ts`、`foundation/tool-boundary.test.ts` |
| O5 | 脚本化 provider 实时 run + 预置历史样本；前端 build 后经 `demo-server.sh` 重启 17455；七张截图覆盖实时、历史、审批、权限变化、长日志、翻页、窄窗格 | `demo-profiles/tools/obs-shot.ts`、`seed-observability-demo.ts`、`obs-00…06.png` |

本轮目标回归结果：

- 后端 13 个目标测试文件：186 通过 / 1 失败；失败项为 Windows 已知基线（`C:\WINDOWS\Temp` EPERM，`workspace/boundary.ts:178`），非本次改动回归。
- 前端 6 个目标测试文件：79 通过 / 0 失败。
- `pc-server` typecheck：我们侧 0 错误（滤除 pi 内部诊断 46）。
- `web-ui` typecheck：通过；`web-ui` build 通过。
- demo 健康检查：`http://127.0.0.1:17455/api/health` 返回 `ok/ready`，数据目录 `demo-profiles/userdata-observability`。
- 动态验收全部使用本地 mock（`127.0.0.2:18124`，`/__state`），未调用真实供应商，零计费请求。

截图与查看位置（均在 `demo-profiles/tools/`）：

- `obs-00-mock-live.png`：真实 mock 生成产生的实时 run。
- `obs-01-live-seeded.png`：预置最新 run 的事件流与权限边界引用。
- `obs-02-history-approval.png`：历史审批 run 的 pending / 拒绝短缘由 / 批准。
- `obs-03-permission-change.png`：同一 run 执行时点的 `full_access` 宽写与系统沙箱叠加。
- `obs-04-long-history.png`：526 条事件 run 的默认最新页（加载 200 条）与边界定义跨页解析。
- `obs-05-long-paged.png`：向前翻页后计数与游标重算。
- `obs-06-narrow.png`：720×900 窄窗格，无横向溢出。

遗留限制（不属本期范围）：每会话最多保留 20 条 run；选择状态刷新后回到 latest；跨重启执行恢复、cron 调度、全局任务中心与不可篡改审计仍留待后续独立计划。验收用 demo 档案与截图产物清理前需单独确认。
