# 开发流程规范

适用于 rdp（RikkaHub Desktop PLUS）仓内的功能开发，工具面治理与后续特性通用。
本文件只约定流程与边界，不含实现方案；具体方案见 `docs/plan-*.md`。

## 1. 动手之前

- 先给结论与方案，得到明确批准再改代码。「先看看 / 只看不改」一律按只读处理，并在回复里说明未动文件。
- 改动前完整读一遍要改的文件，不凭搜索片段做宽幅修改。
- 开工前确认本次范围，不夹带无关重构、格式化或顺手优化。
- 每个故事必须有可演示边界和回归清单，做完才允许进入下一个。

## 2. 目录与归属边界

- `pi/` 是上游 pi 仓，遵守 `pi/agents.md`：不改 `models.generated.ts`、不跑全量 vitest、不用真实供应商做测试、提交信息遵循上游格式。
- `pc-server/workspace/tools/` 下是从 pi 逐字移植的工具内核，默认不改。新契约放装饰层与新模块（如 `pc-server/workspace/ops/`），通过 `runtime.ts` 单点挂载；确需改内核时单独说明理由并记录上游同步成本。
- `Operations` 注入只负责 I/O，不用来改输出文本或 schema。
- `pc-data/` 是运行数据，不当源码改；测试产生的工作区、演示数据、备份目录，清理前先列出清单并征得同意。

## 3. 双引擎通路

- 聊天走 `pc-server/inference-engine/`，pi 走 `pc-server/pi-engine/`。任何工具行为、schema、输出文本的变更都要同时评估两条通路。
- 通用工具声明集中在 `pc-server/tools/definitions.ts`，不要在某一条通路里单独复制一份。
- 会话级长期状态不能挂在 pi 的 AgentSession 上（每次生成销毁），要按 conversation 持久化。

## 4. 前端与输出兼容

- 前端改动需要重新 build web-ui 后才会在 17455 端口生效。
- `edit` 的 `details.diff / patch` 是前端渲染依据；`write` 的成功文本被字节徽标正则依赖，不要改。
- `details` 字段只增不改不删；新增模型可见信息优先追加文本，不破坏既有结构。
- 转换、摘要、去重类成果在时间线就地展示，原文默认折叠，不做只藏弹窗的实现。

## 5. 设置、数据与导出

- 新能力默认关，用灰度开关控制；关闭时行为必须与改动前一致。
- settings 仍是 JSON，记忆与待确认数据在 SQL，不要把两者混写。
- 新增 PC 专属设置字段必须登记安卓导出剥离清单，与 stdio MCP、长文本粘贴等既有规则保持一致。
- 不删除功能、数据或历史记录；确需删除先问。

## 6. 测试与验证

- 在 `pc-server` 下用 `bun test <具体文件>` 跑目标测试，不盲目全量。
- 工具输出或契约变更至少跑：`workspace/tools/tools.test.ts`、`workspace/tools/fallback-tools.test.ts`、`workspace/runtime.test.ts`、`pi-engine/workspace-tools.test.ts`，涉及etag时加 `workspace/files.test.ts`。
- 已知 Windows flake：`C:\WINDOWS\Temp` EPERM（需管理员）与 e2e EBUSY，全量基线里恒定 2–3 项失败不视为回归，不要为此 bisect。smoke 的 EBUSY 同属 flake，清 lock 用 `/api/app/shutdown`。
- 「单跑绿、合跑红」多为跨文件 `globalThis` 桩泄漏，先查桩清理，不要改业务语义迁就测试。
- 验证只用本地 mock（`127.0.0.2:18124`，状态端点 `/__state`），不打计费 API。确需调用计费接口时先报价再动手。
- 新增或修改的测试必须实际跑过并迭代到通过。

## 7. 沙盒与权限

- 受限沙盒（Windows 低完整性）下，写权限与边界判定口径要与既有实现保持一致；不为了让测试通过而放宽边界检查。
- 工作区读取三档全宽、写编严界的语义不得被新工具绕过；批量读、分页续读、结果落盘都要走同一边界断言。
- 权限模式收窄时，与其相关的缓存、激活集、引用必须失效。

## 8. 演示服务与进程

- 每次改动后重启 17455 demo，统一走 `demo-server.sh` 收口；不要直接另起后端进程。
- 不用脚本直起 `server.ts` 留下孤儿进程；确实起过的进程，清理前先报清单。
- shot-host 事后退出码 1 属常态，不作为失败依据。

## 9. Git 纪律

- 只有用户明确要求时才提交；提交只包含本次自己改的文件，逐路径 `git add`，先 `git status` 核对。
- 禁止 `git add -A` / `git add .` / `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash` / `git commit --no-verify`。
- 本仓常有并行编辑会话：不暂存、不还原、不删除不属于自己的改动；rebase 冲突只解决自己改过的文件，其余中止并报告。
- 提交信息说明为什么改，不只罗列改了什么。

## 10. 文档与发布

- 计划文档放 `docs/plan-<主题>.md`，与既有计划命名一致。
- 发布说明只写变更条目，先给短版，不堆升级指引与构建清单。
- 不擅自新增 README 或重复文档；已有文档能更新就不新建。

## 11. 明确不做的事项（工具面治理期间）

- 不引入 LayerFS、Docker、WSL、CAS 文件系统依赖。
- 不做 PTC（代码即工具调用）与 TS SDK 生成。
- 不依赖供应商的 `deferLoading` / `tool-addition` 增量工具下发。
- 不为省 token 牺牲正确性：证据不足时一律返回完整内容。
