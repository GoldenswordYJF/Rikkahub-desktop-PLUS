// scripts/smoke-task-lifecycle.ts — 任务生命周期 L1–L4 的真进程端到端冒烟
//
// 与单测的分工:单测钉函数契约;这里验证"模块之间的耦合"在真实进程里成立——
// 启动收敛真的写库、调度 tick 真的投递并建 run、恢复真的链接旧 run、审计真的能导出、
// 重启幂等、SIGTERM 真的能停。假 LLM 用 test-utils 的本地 SSE,不打外网。
//
// 用法: bun run scripts/smoke-task-lifecycle.ts [dataDir]
//   dataDir 缺省用系统临时目录;流程结束不删除,便于人工复查(路径会打印)。

import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeOpenAiSse } from "../test-utils/fake-openai-sse";

const pcServerDir = resolve(import.meta.dir, "..");
const dataDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "rdp-lifecycle-smoke-"));
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function must(name: string, condition: unknown, detail?: string): void {
  check(name, Boolean(condition), detail);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor<T>(label: string, fn: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      check(label, false, `超时 ${timeoutMs}ms`);
      return null;
    }
    await sleep(500);
  }
}

// ── 1) 假 LLM + 预置 state.json + 预置"上一进程遗留"数据 ───────────────────
const fakeLlm = await startFakeOpenAiSse(
  Array.from({ length: 12 }, () => ({ content: "调试完成。", usage: { prompt_tokens: 10, completion_tokens: 4 } })),
);

const { defaultSettings } = await import("../app-config/defaults");
const settings = structuredClone(defaultSettings()) as Record<string, any>;
settings.preferredPort = 17855;
settings.providers = [
  {
    type: "openai",
    id: "debug-provider",
    enabled: true,
    name: "Debug Provider",
    builtIn: false,
    shortDescription: "debug",
    description: "debug",
    apiKey: "sk-debug",
    baseUrl: fakeLlm.baseUrl,
    models: [
      {
        id: "debug-model",
        modelId: "debug-model",
        displayName: "Debug Model",
        type: "CHAT",
        inputModalities: ["text"],
        outputModalities: ["text"],
        abilities: [],
        tools: [],
      },
    ],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  },
];
const debugAssistant = structuredClone(settings.assistants[0] ?? {});
Object.assign(debugAssistant, {
  id: "debug-assistant",
  name: "Debug Assistant",
  chatModelId: "debug-model",
  presetMessages: debugAssistant.presetMessages ?? [],
  regexes: debugAssistant.regexes ?? [],
  enableMemory: false,
});
settings.assistants = [debugAssistant];
settings.assistantId = "debug-assistant";
settings.chatModelId = "debug-model";
settings.quickModelId = null;
settings.suggestionModelId = null;
settings.agentLoop = {
  enabled: true,
  transportRetry: true,
  maxReplans: 2,
  stallRepeatLimit: 3,
  sameErrorLimit: 3,
  requireVerifiedCompletion: true,
  schedulingEnabled: true,
};
await Bun.write(join(dataDir, "state.json"), JSON.stringify({ settings }, null, 2));

const conversations = await import("../conversations");
const { insertRun, updateRun, appendRunEvent } = await import("../agent-loop/run-store");
const db = conversations.openConversationsDb();
const CONV = "debug-conv";
db.prepare(
  "INSERT OR IGNORE INTO pc_conversation (id, assistant_id, title, create_at, update_at) VALUES (?, 'debug-assistant', '调试会话', 1, 1)",
).run(CONV);
insertRun({ id: "debug-orphan", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 1_000 });
appendRunEvent("debug-orphan", "run_started", "上一进程遗留");
insertRun({ id: "debug-suspended", conversationId: CONV, nodeId: null, engine: "chat", startedAt: 2_000 });
updateRun("debug-suspended", { status: "suspended", phase: "awaiting_approval" });

// ── 2) 起真实 server 子进程 ─────────────────────────────────────────────────
async function bootServer(): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  const proc = Bun.spawn(["bun", "server.ts"], {
    cwd: pcServerDir,
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let buffer = "";
  const deadline = Date.now() + 60_000;
  let port: number | null = null;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), sleep(1_000).then(() => null)]);
    if (chunk?.value) buffer += new TextDecoder().decode(chunk.value);
    const match = buffer.match(/RIKKAHUB_PORT:(\d+)/);
    if (match) {
      port = Number(match[1]);
      break;
    }
    if (proc.exitCode !== null) break;
  }
  if (!port) {
    const stderr = await new Response(proc.stderr as ReadableStream).text().catch(() => "");
    throw new Error(`服务未在 60s 内就绪\n--- stdout ---\n${buffer}\n--- stderr ---\n${stderr}`);
  }
  // 继续把 stdout 读空,避免管道写满阻塞子进程。
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += new TextDecoder().decode(next.value);
      }
    } catch {
      /* 进程退出 */
    }
  })();
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor("startup-ready", async () => {
    try {
      const response = await fetch(`${base}/api/health`);
      return response.ok ? true : null;
    } catch {
      return null;
    }
  }, 60_000);
  if (!ready) throw new Error(`/api/health 未就绪(port=${port})\n${buffer}`);
  return { proc, port };
}

/** 优雅停机走 HTTP 端点(壳的真实路径):Windows 上 SIGTERM 不保证进信号处理器,
 *  锁不会释放——用信号验"能退出"会得到假绿。这里同时验端口关闭 + 锁文件删除。 */
async function stopServer(base: string, proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  try {
    await fetch(`${base}/api/app/shutdown`, { method: "POST" });
  } catch {
    /* 端点可能先于响应退出 */
  }
  const exited = await Promise.race([proc.exited, sleep(20_000).then(() => "timeout" as const)]);
  if (exited === "timeout") {
    proc.kill("SIGTERM");
    return false;
  }
  const lockPath = join(dataDir, "pc-server.lock");
  return !existsSync(lockPath);
}

async function api(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${base}/api/${path}`, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

// ── 3) 第一次启动:收敛 + 调度 + 恢复 + 审计 ────────────────────────────────
let firstSessionOk = true;
try {
  const { proc, port } = await bootServer();
  const base = `http://127.0.0.1:${port}`;

  // 3.1 启动收敛(耦合:run-store + schema migration + bootstrap 顺序)
  const orphan = db.prepare("SELECT status, stop_reason, ended_at FROM pc_generation_run WHERE id = 'debug-orphan'").get() as any;
  must("L1 遗留 running 收敛为 stopped/interrupted", orphan?.status === "stopped" && orphan?.stop_reason === "interrupted" && orphan?.ended_at != null, JSON.stringify(orphan));
  const restartEvents = db
    .prepare("SELECT COUNT(*) AS n FROM pc_generation_run_event WHERE run_id = 'debug-orphan' AND kind = 'run_finished' AND payload LIKE '%process_restart%'")
    .get() as any;
  must("L1 只写一条 process_restart 终局事件", restartEvents?.n === 1, `n=${restartEvents?.n}`);
  const suspended = db.prepare("SELECT status FROM pc_generation_run WHERE id = 'debug-suspended'").get() as any;
  must("L1 suspended 不被误杀", suspended?.status === "suspended");

  // 3.2 设置耦合:agentLoop.schedulingEnabled 已就位
  const settingsResp = await api(base, "settings");
  must(
    "设置:agentLoop.schedulingEnabled 可读",
    settingsResp.body?.agentLoop?.enabled === true && settingsResp.body?.agentLoop?.schedulingEnabled === true,
  );

  // 3.3 调度投递(耦合:schedule-store → scheduler tick → message-queue → orchestrator → beginAgentRun)
  const created = await api(base, `conversations/${CONV}/task-schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "冒烟:到点执行一次", kind: "once", runAt: Date.now() + 2_000 }),
  });
  must("L3 创建 once 调度", created.status === 201, `status=${created.status} body=${JSON.stringify(created.body)}`);
  const scheduleId = created.body?.schedule?.id as string;

  const delivered = await waitFor("L3 tick 投递", () => {
    const row = db.prepare("SELECT last_run_id FROM pc_task_schedule WHERE id = ?").get(scheduleId) as any;
    return row?.last_run_id ? row : null;
  }, 40_000);
  must("L3 调度到点生成 run 并回写 last_run_id", Boolean(delivered), `last_run_id=${delivered?.last_run_id}`);
  const scheduledRunId = delivered?.last_run_id as string;

  if (scheduledRunId) {
    const scheduledRun = db
      .prepare("SELECT schedule_id, status FROM pc_generation_run WHERE id = ?")
      .get(scheduledRunId) as any;
    must("L3 run 反查 schedule_id", scheduledRun?.schedule_id === scheduleId, JSON.stringify(scheduledRun));
    const scheduledMessage = db
      .prepare("SELECT COUNT(*) AS n FROM pc_message_node WHERE conversation_id = ? AND messages LIKE '%\"type\":\"scheduled\"%'")
      .get(CONV) as any;
    must("L3 投递消息带 scheduled 注解", scheduledMessage?.n === 1, `n=${scheduledMessage?.n}`);
    const settled = await waitFor("L3 定时生成收尾", () => {
      const row = db.prepare("SELECT status FROM pc_generation_run WHERE id = ?").get(scheduledRunId) as any;
      return row?.status && row.status !== "running" ? row : null;
    }, 30_000);
    must("L3 定时生成走到终态", settled?.status === "succeeded", `status=${settled?.status}`);
  }

  // 3.4 恢复(耦合:run-recovery 判定 → resume 路由 → plan-context 注解 → beginAgentRun 链接)
  db.prepare(
    "UPDATE pc_generation_run SET status = 'stopped', stop_reason = 'interrupted', ended_at = ? WHERE id = ?",
  ).run(Date.now(), scheduledRunId ?? "debug-orphan");
  const recovery = await api(base, `conversations/${CONV}/agent-runs/${scheduledRunId}/recovery`);
  must("L2 恢复判定为 new_run", recovery.body?.mode === "new_run", JSON.stringify(recovery.body?.mode));
  const resumed = await api(base, `conversations/${CONV}/agent-runs/${scheduledRunId}/resume`, { method: "POST" });
  must("L2 恢复请求 202", resumed.status === 202, `status=${resumed.status} body=${JSON.stringify(resumed.body)}`);
  const resumedRun = await waitFor("L2 新 run 落库", () => {
    const row = db
      .prepare("SELECT id FROM pc_generation_run WHERE conversation_id = ? AND resumed_from_run_id = ?")
      .get(CONV, scheduledRunId) as any;
    return row ?? null;
  }, 30_000);
  must("L2 新 run 链接 resumed_from_run_id", Boolean(resumedRun), `id=${resumedRun?.id}`);
  const resumeMessage = db
    .prepare("SELECT COUNT(*) AS n FROM pc_message_node WHERE conversation_id = ? AND messages LIKE '%\"type\":\"run_resume\"%'")
    .get(CONV) as any;
  must("L2 恢复消息带 run_resume 注解", resumeMessage?.n === 1, `n=${resumeMessage?.n}`);

  // 3.5 审计查询与导出(耦合:run-store 审计 SQL + NDJSON 流 + projection)
  const audit = await api(base, `agent-runs?conversationId=${CONV}`);
  must("L4 跨会话查询返回本会话 run", audit.status === 200 && Array.isArray(audit.body?.runs) && audit.body.runs.length >= 2, `runs=${audit.body?.runs?.length}`);
  const filtered = await api(base, "agent-runs?status=stopped");
  must("L4 状态筛选可用", filtered.status === 200 && filtered.body.runs.every((run: any) => run.status === "stopped"));
  const empty = await api(base, "agent-runs?status=exhausted&conversationId=no-such-conv");
  must("L4 空结果形状稳定", empty.status === 200 && empty.body.runs.length === 0 && empty.body.nextBeforeStartedAt === null);

  const exportRunId = resumedRun?.id ?? scheduledRunId;
  if (exportRunId) {
    const exported = await api(base, `conversations/${CONV}/agent-runs/${exportRunId}/export`);
    const lines = String(exported.body).trim().split("\n").map((line) => JSON.parse(line));
    must(
      "L4 导出 run→events→projection 且事件升序",
      exported.status === 200 &&
        lines[0]?.type === "run" &&
        lines.at(-1)?.type === "projection" &&
        lines.filter((line) => line.type === "event").every((line, index, list) => index === 0 || line.data.seq > list[index - 1].data.seq),
      `lines=${lines.length}`,
    );
    must(
      "L4 导出内容类型 NDJSON",
      String(exported.headers.get("content-type")).includes("application/x-ndjson"),
      String(exported.headers.get("content-type")),
    );
  }

  // 3.6 停机:调度器定时器不得阻止退出
  must("优雅停机:进程退出且释放数据目录锁", await stopServer(base, proc));

  // ── 4) 第二次启动:收敛幂等 + 不再有 running ──────────────────────────────
  const second = await bootServer();
  const runningLeft = db.prepare("SELECT COUNT(*) AS n FROM pc_generation_run WHERE status = 'running'").get() as any;
  must("L1 重启后没有永久 running", runningLeft?.n === 0, `n=${runningLeft?.n}`);
  const restartEventsAfter = db
    .prepare("SELECT COUNT(*) AS n FROM pc_generation_run_event WHERE run_id = 'debug-orphan' AND kind = 'run_finished' AND payload LIKE '%process_restart%'")
    .get() as any;
  must("L1 收敛幂等:终局事件不重复", restartEventsAfter?.n === 1, `n=${restartEventsAfter?.n}`);
  must("第二次优雅停机正常释放锁", await stopServer(`http://127.0.0.1:${second.port}`, second.proc));
} catch (error) {
  firstSessionOk = false;
  check("冒烟执行未抛异常", false, error instanceof Error ? error.message : String(error));
} finally {
  await fakeLlm.close();
}

const failed = results.filter((item) => !item.ok);
console.log("");
console.log(`数据目录: ${dataDir}`);
console.log(`断言 ${results.length} 项:${results.length - failed.length} 通过,${failed.length} 失败`);
if (!firstSessionOk || failed.length > 0) process.exit(1);
