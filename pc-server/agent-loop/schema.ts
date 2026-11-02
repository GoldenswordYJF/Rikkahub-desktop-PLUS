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
}
