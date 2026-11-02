// backup/discovery-export.test.ts — S11 工具发现的跨端 / 跨机边界
// ① settings:enableToolDiscovery 与 workspaceTools.toolDiscovery 都是 PC 专属,
//    to-android 剥离(安卓无对应字段),to-pc(PC→PC 换机)保留。
// ② 会话 dump:tool_activation 不在导出列清单里——激活集是"本机重新发现即可重建"
//    的派生缓存,换机恢复后为空,不会把旧机器的工具名带过去。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-discovery-export-"));

const { Database } = await import("bun:sqlite");
const { rewriteAvatarsInSettings } = await import("./export");
const { openConversationsDb, exportPcConversationsDump } = await import("../conversations");
const { writeToolActivationInto } = await import("../conversations/tool-activation");

function settingsWithAssistant() {
  return {
    enableWebSearch: true,
    workspaceTools: { toolDiscovery: true },
    assistants: [{ id: "a1", name: "A", enableToolDiscovery: true }],
  };
}

describe("工具发现设置的跨端边界", () => {
  test("to-android:剥离 enableToolDiscovery 与 workspaceTools;to-pc:原样保留", () => {
    const android = rewriteAvatarsInSettings(settingsWithAssistant(), {}, "to-android");
    expect("enableToolDiscovery" in android.assistants[0]).toBe(false);
    expect("workspaceTools" in android).toBe(false);

    const pc = rewriteAvatarsInSettings(settingsWithAssistant(), {}, "to-pc");
    expect(pc.assistants[0].enableToolDiscovery).toBe(true);
    expect(pc.workspaceTools).toEqual({ toolDiscovery: true });
  });
});

describe("会话 dump 的激活集边界", () => {
  test("pc_conversation 导出列不含 tool_activation(恢复后按需重新发现)", () => {
    const db = openConversationsDb();
    db.prepare(
      "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES ('backup-discovery-c1', 'a1', '', '', '[]', 0, 1, 1)",
    ).run();
    writeToolActivationInto(db, "backup-discovery-c1", { active: ["mcp__a"], pending: ["mcp__b"] });

    const dumpPath = join(tmpdir(), `rkh-activation-dump-${process.pid}-${Date.now()}.db`);
    // 全量跑测时活库由同进程的其它测试文件共享,行数不固定;导出数应等于导出前的实际行数。
    const expectedRows = (db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n;
    // 不删临时 dump:Windows 上 SQLite 句柄释放滞后,unlink 会偶发 EBUSY(已知测试噪音)。
    expect(exportPcConversationsDump(dumpPath)).toBe(expectedRows);
    const dump = new Database(dumpPath, { readonly: true });
    try {
      const columns = (dump.prepare("PRAGMA table_info(pc_conversation)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).not.toContain("tool_activation");
    } finally {
      dump.close();
    }
  });
});
