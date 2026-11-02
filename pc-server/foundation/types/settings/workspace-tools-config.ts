// foundation/types/settings/workspace-tools-config.ts — 工作区工具面契约开关(PC 专属)
//
// 纪律:所有开关默认关——关闭时 read/edit 的输出与行为逐字保持引入前形态,任何
// 旧会话/旧备份升级后无感。开启后契约对两条生成通路(聊天 / pi)同时生效。
// 跨端:导出安卓时整块剥离(backup/export.ts 的 stripPcOnly 块 + backup/import.ts
// 的 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT);pc-backup(PC→PC)保留。
//
// 加载侧宽容原则(与 subagent-config 同款):存量 state 无此键或字段损坏 → 逐字段回落
// 默认,永不因一个坏字段让 state 起不来。

export interface WorkspaceToolsConfig {
  /** S2:read 输出带 `N|` 行号、`revision=`、`more lines; nextOffset=` 续读位。 */
  readContract: boolean;
  /** S4:同一会话内重复读取未变化的文件时短路为引用(证据不足一律回全文)。 */
  readDedup: boolean;
  /** S5:grep/find/ls 尾部追加覆盖率说明,有缺口时不再给出"没有匹配"的总数断言。 */
  searchCoverage: boolean;
  /** S9/S10:search_tools 发现行 + 按会话激活集(本期只把 MCP 工具放进可发现池)。 */
  toolDiscovery: boolean;
  /** S6:截断结果可续读——bash 落盘提示带总量与 read/grep 指引,
   *  grep/find/ls 达上限时把完整结果落到工作区 tmp/ 并给出续读路径。 */
  resumableOutput: boolean;
  /** S8:MCP 工具超长 description 截断并保留关键说明;关闭时逐字透传。 */
  mcpDescriptionCap: boolean;
}

export function defaultWorkspaceToolsConfig(): WorkspaceToolsConfig {
  return {
    readContract: false,
    readDedup: false,
    searchCoverage: false,
    toolDiscovery: false,
    resumableOutput: false,
    mcpDescriptionCap: false,
  };
}

/** 加载侧归一化:非对象/损坏字段逐项回落默认,永不抛错。 */
export function normalizeWorkspaceToolsConfig(raw: unknown): WorkspaceToolsConfig {
  const defaults = defaultWorkspaceToolsConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  return {
    readContract: typeof input.readContract === "boolean" ? input.readContract : defaults.readContract,
    readDedup: typeof input.readDedup === "boolean" ? input.readDedup : defaults.readDedup,
    searchCoverage: typeof input.searchCoverage === "boolean" ? input.searchCoverage : defaults.searchCoverage,
    toolDiscovery: typeof input.toolDiscovery === "boolean" ? input.toolDiscovery : defaults.toolDiscovery,
    resumableOutput: typeof input.resumableOutput === "boolean" ? input.resumableOutput : defaults.resumableOutput,
    mcpDescriptionCap: typeof input.mcpDescriptionCap === "boolean" ? input.mcpDescriptionCap : defaults.mcpDescriptionCap,
  };
}
