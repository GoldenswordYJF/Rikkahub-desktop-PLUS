# AgentBot 设置 404：落地修复与防复发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让便携版里的 AgentBot 两颗开关真正可写（消除 404），并加一道护栏保证「后端 exe 与前端静态产物」不会再各走各的。

**Architecture:** 根因已定位为产物错配——便携目录的前端是 0.1.5 构建，后端 exe 仍是 10-29 的 0.1.4 构建，`settings/agent-loop` 路由在旧 exe 里不存在，请求打到 `api/router.ts:55` 返回 `Not found`。因此 Plan 分三层：先恢复服务（运维），再补后端路由契约测试（锁住既有行为不被重构掉），最后加部署脚本（成对搬运 + 起新 exe 冒烟）与前端 404 兜底提示（同类错配下次能自己说话）。

**Tech Stack:** Bun 1.4.2 / TypeScript / React Router SPA / i18next / bun:test

**Spec:** 无独立 spec。根因证据见本文件「诊断结论」，行为约定以 `docs/plan-agentbot-observability.md` 与 `pc-server/foundation/types/settings/agent-loop-config.ts` 头部注释为准。

## 诊断结论（执行前必读，别再重查）

| 证据 | 结论 |
|---|---|
| `shell.log` 连续 8 条 `[404] POST /api/settings/agent-loop` | 请求到得了服务进程，是路由不存在，不是前端拼错路径 |
| `api/router.ts:55` → `error("Not found", 404)` | 与界面 toast 的 `Not found` 逐字对应 |
| 便携版 `rikkahub-pc.exe` 大小 118457856 / 时间 10-29 23:31 | 0.1.4 构建，`agentLoop` 路由（11-01 加入）不在其中 |
| `grep -ac "settings/agent-loop" dist/rikkahub-pc.exe` → 2；同一个 grep 对便携 exe → 0 | 仓库侧产物是新的，只有部署是旧的 |
| 便携版 `web-ui/build/client/index.html` 的 asset 哈希与 release-0.1.5 包、与仓库 `web-ui/build` 完全一致 | 前端就是 0.1.5，没被动过；错配只发生在 exe 一侧 |
| 源码起在 17456 端口实测：`POST /api/settings/agent-loop {"enabled":true}` → 200；`GET /api/settings` 回 `"agentLoop":{...}` | 功能本身完整可用，无需重写 |

**一句话：功能没问题，是便携版后端 exe 没跟着换。**

## Global Constraints

- 不得把工作区里未提交的 WIP（`pc-server/tools/plan-graph.ts`、`docs/plan-task-lifecycle.md` 等）打进本次产物；本次只部署已提交的 0.1.5 后端。
- 便携版目录 `D:\Software\Produce\RikkaHub_portable` 是用户在用环境：覆盖前必须先备份 exe，且只覆盖 `rikkahub-pc.exe` / `RikkaHub.exe` / `web-ui\build`，不碰 `pc-data`、`skills`、`头像`、`webview2-data`。
- 后端写侧校验口径不得放宽：`validateAgentLoopPatch` 越界整体拒绝（不夹取、不部分生效），默认值保持 `enabled:false`、`transportRetry:true`。
- 前端新增文案必须 zh-CN / en-US 双语同时补，键名一致。
- 我们侧类型检查必须 0 错：`cd pc-server && bun run typecheck`、`cd web-ui && bun run typecheck`。

## Review Focus

1. **换过 exe 但用户数据仍坏**：`pc-data` 里的 `state.json` 可能已有损坏/缺失的 `agentLoop` 键——加载侧必须逐字段回落默认而不是抛错（`state-load.ts:132` 已有，验收时要覆盖）。
2. **只换了 exe 没换前端（反向错配）**：老前端不认新端点，表现为开关点了不动或整体回退默认——部署脚本必须成对搬运并在同一次运行里冒烟。
3. **部署脚本在目标被占用时半途失败**：只复制了一半就退出，留下「exe 新、web-ui 旧」的残局——脚本必须全量校验通过才落盘，失败回滚。
4. **`transportRetry` 被总开关连坐**：总开关关闭时传输重试仍须独立生效（`orchestrator.ts:516` 用 `!== false`）；任何人把它改成跟 `enabled` 挂钩都是回归。
5. **404 兜底提示把真 404 也吞了**：`isApiNotFound` 只用于设置写入失败的文案分支，不得改变抛错与回滚行为，否则用户看到「版本旧」而实际是别的问题。

---

### Task 1: 恢复便携版后端（P0，无代码）

**Files:**
- Modify（二进制覆盖）: `D:\Software\Produce\RikkaHub_portable\rikkahub-pc.exe`
- Modify（二进制覆盖）: `D:\Software\Produce\RikkaHub_portable\RikkaHub.exe`
- Backup: `D:\Users Data\Desktop\rikkahub\backups\portable-0.1.4-exe-<YYYYMMDD-HHmm>\`

**Interfaces:**
- Consumes: 仓库 `dist/rikkahub-pc.exe`（118617600 字节 / 11-02 11:20，含 `settings/agent-loop`）
- Produces: 可用的 `http://127.0.0.1:17455/api/settings/agent-loop`；后续 Task 3 的脚本以此布局为目标

- [ ] **Step 1: 校验源产物确实是带路由的新版**

Run:
```bash
cd "D:/Users Data/Desktop/rikkahub/rikkahub-desktop-plus"
grep -ac "settings/agent-loop" dist/rikkahub-pc.exe   # 期望 2
ls -la dist/rikkahub-pc.exe dist/web-ui 2>/dev/null
```
Expected: `2`；文件大小 118617600，时间不早于 11-02 11:20。若为 0，先 `cd pc-server && bun run compile` 再回来。

- [ ] **Step 2: 备份现有旧 exe**

Run:
```bash
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "D:/Users Data/Desktop/rikkahub/backups/portable-0.1.4-exe-$STAMP"
cp "D:/Software/Produce/RikkaHub_portable/rikkahub-pc.exe" "D:/Users Data/Desktop/rikkahub/backups/portable-0.1.4-exe-$STAMP/"
cp "D:/Software/Produce/RikkaHub_portable/RikkaHub.exe" "D:/Users Data/Desktop/rikkahub/backups/portable-0.1.4-exe-$STAMP/"
```
Expected: 目录里有两个 exe，且旧 `rikkahub-pc.exe` 为 118457856 字节。

- [ ] **Step 3: 优雅关闭正在运行的壳**

Run:
```bash
curl -s -X POST http://127.0.0.1:17455/api/app/shutdown; sleep 4
netstat -ano | grep 17455 | head -3
```
Expected: `{"ok":true}`；随后 17455 只剩 TIME_WAIT，无 LISTENING。若壳进程仍在（`RikkaHub.exe`），再 `taskkill //PID <pid> //F`。

- [ ] **Step 4: 覆盖 exe（只覆盖这两个文件）**

Run:
```bash
cp "D:/Users Data/Desktop/rikkahub/rikkahub-desktop-plus/dist/rikkahub-pc.exe" "D:/Software/Produce/RikkaHub_portable/rikkahub-pc.exe"
ls -la "D:/Software/Produce/RikkaHub_portable/rikkahub-pc.exe"
grep -ac "settings/agent-loop" "D:/Software/Produce/RikkaHub_portable/rikkahub-pc.exe"   # 期望 2
```
Expected: 大小 118617600，grep 得 `2`。`RikkaHub.exe` 保持 10-29 版本即可——壳只是 WebView2 宿主，与本问题无关，不动它风险更低。

- [ ] **Step 5: 冷启动壳并冒烟**

Run:
```bash
start "" "D:/Software/Produce/RikkaHub_portable/RikkaHub.exe"
sleep 8
curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:17455/api/settings/agent-loop \
  -H "Content-Type: application/json" -d '{"enabled":false}'
```
Expected: HTTP 200 且 body 含 `"agentLoop":{"enabled":false,...}`。若仍 404，说明跑的不是这个 exe（检查 `netstat -ano | grep 17455` 的 PID 对应路径）。

- [ ] **Step 6: 界面验收**

在 设置 › 实验功能 › AgentBot 依次点击「启用 AgentBot」「传输重试」，再刷新页面回来确认两个开关保持刚才的状态。同时在 `shell.log` 里确认不再出现 `[404] POST /api/settings/agent-loop`。

---

### Task 2: 后端路由契约测试

**Files:**
- Create: `pc-server/api/agent-loop-settings-route.test.ts`
- Test: 同文件

**Interfaces:**
- Consumes: `handleSettingsRoutes(request, url, path)`（`pc-server/api/handlers/settings.ts`）、`validateAgentLoopPatch` 的 200/400 口径
- Produces: 无（纯护栏）

- [ ] **Step 1: 写测试（对着现有实现写，跑起来应当是绿的——这是特征化测试，不是 TDD）**

```ts
// api/agent-loop-settings-route.test.ts — settings/agent-loop 路由契约锁。
// 锁三件事:① 布尔开关落库且回传整块;② 整数越界/类型不符整单 400 且不落库;
// ③ GET /settings 必须带 agentLoop(界面读的是同一份,缺了开关会静默回默认)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-agent-loop-route-"));

import { defaultSettings } from "../app-config/defaults";
import { defaultAgentLoopConfig } from "../foundation/types/settings/agent-loop-config";
import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postAgentLoop(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/agent-loop");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/agent-loop");
}

beforeAll(() => {
  setState({ settings: { ...defaultSettings(), agentLoop: defaultAgentLoopConfig() } } as unknown as State);
});

describe("settings/agent-loop", () => {
  test("布尔开关落库并回传整块", async () => {
    const res = await postAgentLoop({ enabled: true, transportRetry: false });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { agentLoop: Record<string, unknown> };
    expect(body.agentLoop.enabled).toBe(true);
    expect(body.agentLoop.transportRetry).toBe(false);
    expect(state.settings.agentLoop.enabled).toBe(true);
  });

  test("整数越界整单拒绝,现值不变", async () => {
    const before = state.settings.agentLoop.maxReplans;
    const res = await postAgentLoop({ maxReplans: 99 });
    expect(res?.status).toBe(400);
    expect(state.settings.agentLoop.maxReplans).toBe(before);
  });

  test("类型不符整单拒绝", async () => {
    const res = await postAgentLoop({ enabled: "yes" });
    expect(res?.status).toBe(400);
  });

  test("无识别字段整单拒绝", async () => {
    const res = await postAgentLoop({ nope: 1 });
    expect(res?.status).toBe(400);
  });

  test("GET /settings 带 agentLoop", async () => {
    const url = new URL("http://127.0.0.1/api/settings");
    const res = await handleSettingsRoutes(new Request(url), url, "settings");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.agentLoop).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `cd pc-server && bun test api/agent-loop-settings-route.test.ts`
Expected: 5 pass。若有红：说明 `handleSettingsRoutes` 的签名或返回约定与上面不同，先照着现有 `api/default-models-toggles.test.ts` 的实际写法对齐，**不要改实现去迁就测试**。

- [ ] **Step 3: 跑全量门禁**

Run: `cd pc-server && bun run typecheck && bun test`
Expected: 0 类型错误；测试全绿（含工作区里既有的 WIP 测试——若 WIP 自身是红的，记录并跳过，别顺手改它的实现）。

- [ ] **Step 4: 提交**

```bash
git add pc-server/api/agent-loop-settings-route.test.ts
git commit -m "test(settings): 锁住 settings/agent-loop 路由契约，防重构丢分支"
```

---

### Task 3: 成对部署脚本（防复发的核心）

**Files:**
- Create: `pc-server/scripts/deploy-portable.ts`
- Modify: `pc-server/package.json`（`scripts` 增加一条 `deploy:portable`）
- Test: 手跑（脚本本身就是可执行校验器，不额外写单测）

**Interfaces:**
- Consumes: `dist/rikkahub-pc.exe`、`web-ui/build/client/`
- Produces: `bun run --cwd pc-server deploy:portable --target <便携目录>`；退出码 0 = 成对部署且新 exe 冒烟通过，1 = 未部署/已回滚

- [ ] **Step 1: 写脚本**

实现要点（每条都是硬要求）：
- 参数：`--target` 必填；缺省则报错退出，**不要**猜默认路径。
- 前置校验：`dist/rikkahub-pc.exe`、`web-ui/build/client/index.html` 必须存在；任一缺失 → 打印缺什么 + 退出 1，不碰目标目录。
- 备份：若目标已有 `rikkahub-pc.exe`，先复制到 `<target>/backup-<YYYYMMDD-HHmm>/`。
- 冒烟探针：用 `PORT=17599` + `RIKKAHUB_PC_DATA_DIR=<tmp>` 起**源** exe（不是复制后再起，避免锁目标目录），等 stdout 出现 `RikkaHub PC server running at` 后 `POST /api/settings/agent-loop {"enabled":false}`，断言状态码 ≠ 404；随后 `POST /api/app/shutdown` 收尾。探针失败 → 直接退出 1，一个字节都不落盘。
- 搬运：`rikkahub-pc.exe` → 目标根；`web-ui/build/client` 下所有文件 → `<target>/web-ui/build/client`（先删后拷，避免旧哈希残留）。
- 收尾打印：exe 大小/时间、前端 `index.html` 的 asset 哈希、备份目录路径。

- [ ] **Step 2: 加 npm script**

```json
"deploy:portable": "bun run scripts/deploy-portable.ts"
```

- [ ] **Step 3: 反向验证脚本会拦住错配（这条最重要）**

Run:
```bash
cd pc-server
mkdir -p /tmp/bad-dist && cp /path/to/old-rikkahub-pc.exe /tmp/bad-dist/   # 或在临时目录伪造一个不含路由的 exe
bun run deploy:portable --target "D:/tmp/probe-target"
```
Expected: 探针报 404 → 退出码 1，`D:/tmp/probe-target` 内没有任何新增 exe。这一步证明护栏真的会响，不是摆设。

- [ ] **Step 4: 正向跑一次真部署**

Run: `cd pc-server && bun run deploy:portable --target "D:/Software/Produce/RikkaHub_portable"`
Expected: 打印 `[deploy-portable] 冒烟通过`、两个产物的版本信息、备份目录；退出码 0。跑完按 Task 1 Step 5-6 再做一次界面验收。

- [ ] **Step 5: 提交**

```bash
git add pc-server/scripts/deploy-portable.ts pc-server/package.json
git commit -m "build(deploy): 便携版成对部署 + 新 exe 路由冒烟，杜绝前后端产物错配"
```

---

### Task 4: 前端 404 兜底提示

**Files:**
- Modify: `web-ui/app/services/api.ts`（`ApiError` 之后加一个判定函数）
- Modify: `web-ui/app/components/settings/experiments/agent-bot.tsx`（`patch()` 的 catch 分支）
- Modify: `web-ui/app/locales/zh-CN/settings.json`、`web-ui/app/locales/en-US/settings.json`（`experiments.agent_bot` 下加 `stale_backend`）
- Test: `web-ui/app/tests/api-not-found.test.ts`

**Interfaces:**
- Produces: `export function isApiNotFound(err: unknown): boolean` —— 仅当 `err instanceof ApiError && err.code === 404` 为 `true`；不改变任何抛错行为。

- [ ] **Step 1: 写测试**

```ts
// app/tests/api-not-found.test.ts — 404 判定只认 ApiError.code,别把网络错误也算进来。
import { describe, expect, test } from "bun:test";
import { ApiError, isApiNotFound } from "~/services/api";

describe("isApiNotFound", () => {
  test("ApiError 404 为真", () => {
    expect(isApiNotFound(new ApiError("Not found", 404))).toBe(true);
  });
  test("其它 ApiError 为假", () => {
    expect(isApiNotFound(new ApiError("bad", 400))).toBe(false);
    expect(isApiNotFound(new ApiError("boom", 500))).toBe(false);
  });
  test("非 ApiError 为假", () => {
    expect(isApiNotFound(new Error("network"))).toBe(false);
    expect(isApiNotFound(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd web-ui && bun test app/tests/api-not-found.test.ts`
Expected: FAIL —— `isApiNotFound` 没有从 `~/services/api` 导出。

- [ ] **Step 3: 实现 `isApiNotFound`**

在 `web-ui/app/services/api.ts` 的 `ApiError` 类之后：

```ts
/** 后端没有这个接口:通常是「界面比服务端新」(旧 exe / 旧容器)。只认 code,不看文案。 */
export function isApiNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.code === 404;
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd web-ui && bun test app/tests/api-not-found.test.ts`
Expected: 3 pass。

- [ ] **Step 5: 接进 AgentBot 页的失败分支**

`agent-bot.tsx` 顶部改 import：`import api, { isApiNotFound } from "~/services/api";`
`patch()` 的 catch 改为：

```ts
} catch (err) {
  onSettings({ ...settings, agentLoop: previous });
  toast.error(
    isApiNotFound(err)
      ? t("settings:experiments.agent_bot.stale_backend")
      : errorText(err),
  );
}
```

- [ ] **Step 6: 补双语文案**

`zh-CN/settings.json` → `experiments.agent_bot` 内加：

```json
"stale_backend": "服务端没有这个设置接口：界面比后端新。请把 RikkaHub 更新到同一版本后再试（多半是只换了前端、没换后端程序）。"
```

`en-US/settings.json` → 同一路径：

```json
"stale_backend": "The server has no such settings endpoint: the UI is newer than the backend. Update RikkaHub so both are the same version (usually the frontend was updated without the backend binary)."
```

- [ ] **Step 7: 前端门禁**

Run: `cd web-ui && bun run typecheck && bun test app`
Expected: 0 类型错误；测试全绿。

- [ ] **Step 8: 提交**

```bash
git add web-ui/app/services/api.ts web-ui/app/components/settings/experiments/agent-bot.tsx \
        web-ui/app/locales/zh-CN/settings.json web-ui/app/locales/en-US/settings.json \
        web-ui/app/tests/api-not-found.test.ts
git commit -m "fix(settings): 设置写入 404 时提示后端版本落后，不再只报 Not found"
```

---

## 收尾验收（全 Plan 完成后一次性跑）

- [ ] `curl -s -X POST http://127.0.0.1:17455/api/settings/agent-loop -d '{"enabled":true}' -H "Content-Type: application/json" -w "\n%{http_code}\n"` → 200
- [ ] 设置页两颗开关点完刷新仍保持；`shell.log` 无新增 `[404] POST /api/settings/agent-loop`
- [ ] 关掉总开关后 `transportRetry` 仍为开（独立生效），`GET /api/settings` 的 `agentLoop` 反映真实状态
- [ ] `cd pc-server && bun run typecheck && bun test` 与 `cd web-ui && bun run typecheck && bun test app` 双绿
- [ ] `bun run deploy:portable --target <错配目标>` 在缺路由时退出码 1（护栏仍然会响）

## 不在本期范围

- 任务生命周期与调度（`docs/plan-task-lifecycle.md`、`docs/plan-planner-task-graph.md`）——工作区 WIP，本次不部署、不提交。
- Docker / 飞牛 OS 侧的同类错配——镜像与二进制同层构建，不存在这个问题；真要防，在 `docker-compose.yml` 里固定 tag 即可，另开一期。
