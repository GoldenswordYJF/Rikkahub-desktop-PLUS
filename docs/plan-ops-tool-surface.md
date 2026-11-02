# 计划：工具面治理与 dsh-ops 契约整合

状态：S1–S12 已实施；所有新契约默认关闭，关闭时两条通路与改动前一致。端到端验收见
`pc-server/pi-engine/tool-contract-e2e.test.ts`（假 OpenAI SSE + 本地假 MCP，零计费）。
范围：整合 dsh-ops 的可移植契约、治理大量工具造成的 prompt 膨胀与凌乱、实现动态工具加载。
不做：LayerFS 及其依赖（Docker / WSL / CAS 文件系统）、PTC（代码即工具调用）、依赖供应商的 `deferLoading` / `tool-addition` 增量下发。

## 1. 背景与判断

dsh-ops 的价值不在它的 DSH API，而在一组可移植契约：读取带行号与版本、编辑带版本前置、重复读取可短路、搜索结果区分「没搜到」与「没搜完」、工具面按需披露。rdp 目前的短板与这些契约一一对应，且 rdp 自己就是 harness，多数证据可以直接从本轮请求里取，不需要 dsh-ops 那套跨进程证明链。

动态工具加载在 rdp 上有两个现成支点：skills 已经是「目录注入 + `use_skill` 懒取正文」的同构结构；pi 引擎原生提供 `setActiveToolsByName`，天然表达「下一轮生效」。因此不引入供应商特性，自己实现发现行。

## 2. 现状诊断（证据）

### 2.1 工具面与 prompt

- 两条引擎通路：聊天走 `pc-server/inference-engine/tool-loop.ts`，pi 走 `pc-server/conversations/orchestrator.ts:952-973`。通用工具声明同源（`pc-server/tools/definitions.ts`），工作区工具 schema 在各自内核。
- 聊天工具数组顺序为 search → local → skill → MCP → subagent（`pc-server/tools/bound.ts:51-58`）；MCP 工具无截断地全量映射。
- MCP 的 `$ref` 内联展开无 memo，同一 definition 被多处引用会重复展开，最后删除 `$defs`（`pc-server/tools/schema-inline.ts:81-121,126-133`）。这是体积膨胀的结构性来源之一。
- MCP 工具名只有 `mcp__<tool>`，不含 server 名，跨 server 可能重名（`pc-server/tools/definitions.ts:231-259`）。这属于正确性隐患，不只是命名美观问题。
- 内置 description 最长的是 `search_web` 约 1000 字、`subagent_dispatch` 约 880 字；MCP description 原样透传、无长度上限。
- 系统提示词中 `Available tools` 只列 7 个工作区工具 snippet，通用工具与 MCP 刻意不进正文。因此模型对「我有哪些工具」的认知几乎完全来自 tools 数组本身：工具一多，就是几十上百个 schema 平铺，没有目录、没有分组、没有优先级。
- 已有裁剪入口：`assistant.localTools / mcpServers / mcpToolOverrides / enabledSkills`，默认 `[time_info] / [] / {} / []`（`pc-server/assistants/index.ts:47-54`）；全局 `subagent.allowedTools` 默认不含 bash。

### 2.2 工具结果契约

- `read` 直出原文，无行号、无版本；只有截断时追加一行提示（`pc-server/workspace/tools/read.ts:141-172`）。
- `edit` 现场读后直接写，无 hash / mtime 校验、无 dryRun（`edit.ts:163-176`）。侧边栏人工编辑却已有 etag 乐观锁：`etag` = 原始字节 SHA-256 前 32 位，冲突返回 409（`pc-server/workspace/files.ts:90-92,155-163,244-279`）。即「人在 UI 改、agent 再写」目前会静默覆盖。
- 同会话重读未变文件仍全文回灌，无任何去重。
- bash 超 50KB / 2000 行落盘到 `pc-data/workspaces/<id>/tmp/pi-bash-<16hex>.log`，只回一个裸路径；grep / find / ls 截断后不落盘。
- grep / find / ls 的截断计数（`matchLimitReached` / `visitCapReached` / `resultLimitReached` / `entryLimitReached`）只写在 `details`，供 UI 使用，模型不可见。

### 2.3 可复用的既有能力

- 装饰层挂载点：`pc-server/workspace/runtime.ts:451-456` 之间，两条引擎通路都覆盖。`Operations` 注入是 I/O 层（readFile / writeFile / exec 等），可用来实现 CAS，但不能改 schema 与输出文本。
- 前端只依赖 `edit` 的 `details.diff / patch`；`write` 的字节徽标正则依赖成功文本，不能改；`read` 的 `details.truncation` 前端不渲染。结论：read 输出格式可自由升级，write 文本保持不动，details 只增不改。
- 去重证据：聊天通路本轮实际消息在 `tool-loop.ts:235-243` 的 `requestBody`；pi 通路可查 `session.messages`。压缩没有 generation 号，但有效压缩记录的 `cutMessageId / createdAt` 可当作去重失效键（`inference-engine/engine-compaction.ts:18-27,47-63`）。
- 工具原文持久化在 `pc_message_node.messages` 的 `ToolPart.output`，可按会话倒序检索。

## 3. 目标与验收指标

1. 工具面可计量：任意助手配置下能离线算出 tools 数组字节数、schema 数、估算 token，并列出最大的前 N 个工具。
2. 默认配置行为不变：所有新能力由开关控制，灰度关闭时输出与现状一致。
3. MCP 工具不再无条件全量常驻：开启发现行后，常驻面只保留核心工具与发现入口。
4. 读取可定位、编辑可防误覆盖、搜索可判完整性、重读可短路、截断可续读。
5. 全程零计费 API 调用：验收使用本地 mock。

## 4. 故事清单

依赖顺序即执行顺序。每个故事可在一次编码执行内完成，均附演示边界与回归点。

### S1 工具面计量脚本

任务：离线脚本读取助手配置与已同步 MCP 工具快照，组装出与线上一致的 tools 数组；输出总字节、schema 数、粗估 token、Top N 最大工具与最大 description；支持 `--assistant` 与 `--json`；脚本放 `pc-server/scripts/`，不进运行时路径；附一份基线数据到计划附录。
演示边界：对当前 demo 配置跑出一张工具面账单，明确膨胀主要来自哪几项。
回归：无运行时改动，只需脚本能跑通。
blockedBy：无

### S2 读取契约升级（行号 + revision + 续读位）

任务：在 `runtime.ts` 装饰层为 read 输出加 `N|` 行号、`revision=`（复用 SHA-256 前 32 位算法）、`more lines; nextOffset=` 与 `end of file`；正文做可逆转义，防止模型伪造行号与文件标题；同步更新 `pi-engine/workspace-tools.ts` 的 snippet 说明新格式与续读用法；保持 `details.truncation` 不变；加开关控制，关闭时输出与现状逐字一致。
演示边界：读一个 200 行文件，模型能报出准确行号并用 nextOffset 续读第二页。
回归：`workspace/tools/tools.test.ts`、`workspace/runtime.test.ts`、`pi-engine/workspace-tools.test.ts`；新增格式与转义用例。
blockedBy：S1

### S3 编辑版本前置（expectedRevision + dryRun）

任务：edit 增加可选 `expectedRevision` 与 `dryRun`；不传 revision 时保持旧行为；版本不符返回结构化错误（含当前 revision、`effectState: none`、建议重读），不写文件；dryRun 复用现有匹配与 diff 算法但跳过写入；多条 edits 维持整批原子；校验放在 agent 写通路已有的串行队列内，声明只保证 agent 通路内的语义校验，不承诺跨进程强一致。
演示边界：人在侧边栏改过文件后，agent 持旧 revision 编辑被拒绝并拿到当前 revision，而不是静默覆盖。
回归：tools.test.ts、runtime.test.ts、files.test.ts；新增冲突、dryRun 无副作用、部分失配整批拒绝用例。
blockedBy：S2

### S4 重复读取去重

任务：按会话维护读取指纹（路径、行范围、revision、参数）；仅当上一次成功读取的原文仍存在于本轮将发送的消息列表中时才短路；压缩记录变化、文件 revision 变化、权限或工作区变化、证据不足时一律返回全文；短路结果保留路径、行范围、revision、续读位与指向原调用的编号；每会话保留上限（建议 32 条）；两条通路分别接证据源。
演示边界：连续两次读同一未变文件，第二次只回一行未变化引用；触发一次压缩后再读，必须回到全文。
回归：新增去重与失效用例；重点覆盖压缩后不得短路。
blockedBy：S2

### S5 搜索覆盖可见化

任务：把 `details` 中已有的截断与访问上限计数追加为模型可见的尾部摘要（已扫描、已跳过、是否达上限、截断原因、下一步建议）；明确「范围外排除不算缺口、读失败算缺口」；缺口存在时不输出「共 N 个匹配」这类总数断言；不改 details 字段名与前端渲染。
演示边界：grep 命中 100 条上限时，模型结论必须是「已返回 100 条，扫描未完整」，而不是「只有这些」。
回归：fallback-tools.test.ts；新增上限与缺口文案用例。
blockedBy：无（可与 S2 并行）

### S6 截断结果可续读

任务：bash 落盘提示从裸路径升级为带总量与续读指引的说明（总行数、字节数、落盘路径、用 read 的 offset/limit 续读、可在该文件内 grep）；grep / find / ls 达上限时同样落盘并给出续读路径；落盘文件沿用工作区 tmp 目录与既有生命周期，不新增清理策略。
演示边界：一次超长 bash 输出后，模型无需重跑命令即可分页读完，并能只 grep 其中的错误段。
回归：tools.test.ts、output-accumulator 相关用例；确认临时文件仍只在工作区内。
blockedBy：无（可与 S2 并行）
备注：完整的 `ref://` 句柄 + page/release 协议暂缓，避免过度工程；若 S6 实测仍不够再单独立项。

### S7 批量读取工具

任务：新增 `read_files`，一次 1–32 个文件、逐项独立 offset/limit、逐项错误独立成项不牵连他项、两层完成状态（整体 pending 与逐文件 complete/nextOffset）、响应按转义后字节设上限；复用 S2 的行号与 revision 格式；默认进入常驻面还是发现池由 S1 的账单决定，倾向常驻。
演示边界：一次调用读 5 个文件，其中 1 个不存在，其余 4 个正常返回并各自带续读位。
回归：新增批量读测试；复用 S2 回归集。
blockedBy：S2

### S8 MCP schema 与描述治理

任务：`$ref` 展开加 memo，相同子树只计算一次；对 MCP description 设长度上限并保留关键说明；统计裁剪前后体积；共享定义提升（保留 `$defs` 与 `$ref`）只在确认目标供应商支持后再议，本期不做。
演示边界：同一配置下 tools 数组体积下降且工具调用参数校验行为不变。
回归：schema-inline 相关测试；用 S1 账单做前后对比。
blockedBy：S1

### S9 聊天通路工具发现行

任务：定义核心常驻面与可发现池（本期只把 MCP 工具入池，本地工具不动）；新增 `search_tools`，确定性关键词匹配、不调模型、maxResults 1–5、支持 `select:<全名>` 直选；命中只登记为待激活，下一轮组装时才进入工具数组；激活集按 conversation 持久化，重启后保留；系统提示词新增工具目录段，只列当前已激活与可发现的条目，避免每轮变动破坏前缀缓存；助手级灰度开关，默认关。
演示边界：开启开关后，初始请求不再携带全部 MCP schema；模型通过 search_tools 找到目标工具，下一轮即可调用；关闭开关时行为与现状一致。
回归：tool-loop 与工具绑定测试；缓存前缀稳定性检查（激活前不变更本轮数组）。
blockedBy：S1、S8

### S10 pi 通路发现行与子智能体规则

任务：pi 侧全集注册、默认只激活核心面与 search_tools；用原生 `setActiveToolsByName` 实现下一轮生效；与聊天通路共用同一份 conversation 级激活集；子智能体按 `allowedTools` 重新装配，与父激活集取交集，不直接继承父数组。
演示边界：pi 引擎会话同样能发现并调用 MCP 工具；子智能体不会获得父会话已激活但被 allowedTools 排除的工具。
回归：pi-engine 工具注册与子智能体测试。
blockedBy：S9

### S11 激活集失效与运维

任务：权限模式收窄、MCP server 被禁用或删除、工具被 override 关闭时清理对应激活项并取消待激活；会话迁移与导出时按 PC 专属字段规则处理；提供诊断输出（当前激活集、待激活、失效原因）；补充失败路径：发现的工具在激活前被删除，调用时返回明确错误而非未知工具崩溃。
演示边界：禁用某个 MCP server 后，其工具立即不可调用且激活集被清理，重新启用后可再次发现。
回归：新增失效与竞态用例。
blockedBy：S9、S10

### S12 端到端 mock 验收与文档

任务：用本地 mock 跑完整场景（发现 → 调用 → 分页续读 → 重读去重 → 压缩后回全文 → 编辑冲突）；输出 S1 账单的前后对比；更新 README 与设置说明；整理发布说明短版（只写变更条目）。
演示边界：零计费 API 完成全流程验收，指标可复现。
blockedBy：S3、S4、S5、S6、S7、S10、S11

### 暂缓项

- MCP 工具跨 server 重名：需要改命名并迁移 `mcpToolOverrides` 的键，属于独立正确性修复，单独立项，不混入本期。
- `ref://` 结果引用协议、共享 `$defs` 提升、PTC：见各故事备注。

## 5. 风险与对策

- 输出格式变化影响模型行为：所有格式升级配开关，先小范围自用验证；snippet 同步更新，避免模型拿到新格式却没有说明。
- 去重导致信息缺失：证据不足一律回全文；压缩、权限变化、工作区变化必须失效，这是本计划最高优先级的正确性约束。
- 双通路遗漏：每个工具行为故事都要同时检查聊天与 pi 两条通路，验收清单中单列。
- 前缀缓存被破坏：发现行坚持下一轮生效；目录段只随激活集变化，不随每轮状态变化。
- 移植内核漂移：默认不改 `workspace/tools/` 内的 pi 移植内核，新契约放装饰层与新模块；确需修改时单独说明并记录上游同步成本。
- 并行编辑冲突：本仓常有并行会话，typecheck 在未触碰文件报错不视为本次回归，语义问题只报告不顺手改。

## 6. 附录：工具面账单（S1 / S8 / S9 / S10）

复现命令（`pc-server/` 下）：

```bash
bun run scripts/tool-surface.ts
bun run scripts/tool-surface.ts --desc 4000 --cap-descriptions
```

固定 fixture：40 个 MCP 工具 / 4 个服务器 / 12 个技能；token 为 chars/4 的廉价估算，只用于相对比较。

### 6.1 发现行前后（首轮 0 个 MCP 已激活，最坏情况）

| 面 | tools 数组 | 声明体积 | 目录段 | 进上下文合计 |
| --- | --- | --- | --- | --- |
| chat | 54 → 15 | 52.2KB → 12.0KB（省 40.2KB） | +1.1KB | 55.0KB → 15.9KB（省 39.0KB） |
| pi | 49 → 10 | 49.1KB → 8.9KB（省 40.2KB） | +1.1KB | 54.4KB → 15.4KB（省 39.0KB） |

账单同时证明两件事：首轮不再携带 40 个 MCP schema；成本侧只增加约 1.1KB 的目录段，净省约 39KB。激活后按实际加载数线性回升，未加载的工具始终只有名字出现在目录段。

### 6.2 MCP description 截断（S8）

`--desc 4000 --cap-descriptions`：40 个工具的 description 合计 156.3KB → 58.6KB（省 97.7KB，40/40 命中）；同配置下 chat 声明体积 103.9KB。关闭开关时逐字透传，账单回到 200KB 级别。

### 6.3 端到端验收覆盖

`pc-server/pi-engine/tool-contract-e2e.test.ts` 用 11 轮假 SSE 剧本串起：MCP 发现 → 下一轮激活与调用 → 分页续读（`nextOffset` → `end of file`）→ 同参数重读去重（`[unchanged: … ref #…]`）→ `read_files` 批量成功/失败并存 → 陈旧 `expectedRevision` 被拒且磁盘未写 → 用当前 revision 重试成功 → 空历史（压缩后视图）重读必须回全文。断言同时检查上游请求体与磁盘，零外网、零计费。
