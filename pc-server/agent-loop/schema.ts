// agent-loop/schema.ts — 自主循环运行记录表(PC 专属,与对话同库)
//
// 建表从 conversations/index 调(openConversationsDbUnsafe),不在 agent-loop 侧反向
// import 会话模块,避免循环导入。表只在总开关启用后有写入,但建表恒执行(幂等、零成本):
// 关闭状态只是不写,不是不建——否则开启后第一次生成要等下一次启动才有表。
//
// 跨端纪律:pc_generation_run / pc_generation_run_event 只在 PC 自有库;安卓导出白名单
// 不含此表(backup/file-refs 之外无引用)。

import type { Database } from "bun:sqlite";

/** 每个会话保留的 run 条数(超出按 started_at 淘汰,级联删事件)。 */
export const AGENT_RUN_RETENTION_PER_CONVERSATION = 20;

export function ensureAgentLoopTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_generation_run (
      id              TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      node_id         TEXT,
      engine          TEXT NOT NULL DEFAULT 'chat',
      status          TEXT NOT NULL DEFAULT 'running',
      phase           TEXT NOT NULL DEFAULT 'planning',
      stop_reason     TEXT,
      rounds          INTEGER NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      replan_count    INTEGER NOT NULL DEFAULT 0,
      stall_reason    TEXT,
      goal            TEXT,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      error           TEXT,
      FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pc_generation_run_conv
      ON pc_generation_run(conversation_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS pc_generation_run_event (
      run_id  TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      at      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      payload TEXT,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES pc_generation_run(id) ON DELETE CASCADE
    );
  `);

  // 生命周期 L1:旧库原地补列。SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS,
  // 先读 table_info 再补,重复启动/测试同库均幂等。
  const columns = db.prepare("PRAGMA table_info(pc_generation_run)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("resumed_from_run_id")) {
    db.exec("ALTER TABLE pc_generation_run ADD COLUMN resumed_from_run_id TEXT");
  }
  if (!names.has("schedule_id")) {
    db.exec("ALTER TABLE pc_generation_run ADD COLUMN schedule_id TEXT");
  }

  // 生命周期 L3:耐久 once / fixed_interval 调度。删除会话时由删除流程显式级联清理
  // (本仓不假设 foreign_keys pragma 恒开启,CASCADE 只作第二道保险)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_task_schedule (
      id              TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      goal            TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK(kind IN ('once', 'fixed_interval')),
      run_at          INTEGER,
      interval_seconds INTEGER,
      next_run_at     INTEGER NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      misfire_policy  TEXT NOT NULL DEFAULT 'catch_up_once'
        CHECK(misfire_policy IN ('skip', 'catch_up_once')),
      last_run_at     INTEGER,
      last_run_id     TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pc_task_schedule_due
      ON pc_task_schedule(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_pc_task_schedule_conv
      ON pc_task_schedule(conversation_id, created_at DESC);
  `);
}
