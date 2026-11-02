// tools/discovery-store.ts — S9 工具发现的运行时粘合层(全局 state + 会话激活集)
//
// 纯逻辑在 tools/discovery.ts;本文件只做四件事:
//  1. 把 conversationFunctionTools(含 S8 描述截断)与激活集合成"本轮真正的工具数组";
//  2. 生成系统提示词的工具目录段;
//  3. search_tools 执行:池匹配 → 命中登记 pending(下一轮生效)→ 回灌文本;
//  4. S11 运维:按实时池清理失效激活项 + 输出诊断(激活/待激活/失效原因)。
//
// 开关关闭 / 无会话 id / 无 MCP 工具时,所有入口都原样返回,与引入前逐字一致。

import type { Assistant, JsonValue, Model } from "../foundation/types";
import { getStringArray, isRecord } from "../foundation/utils";
import {
  emptyToolActivation,
  pruneToolActivation,
  readToolActivation,
  registerPendingToolActivation,
  type ToolActivationState,
} from "../conversations/tool-activation";
import { state } from "../persistence/json-store";
import { getMcpToolOverride } from "./approval";
import { conversationFunctionTools, openAiMcpTools } from "./bound";
import {
  applyToolDiscovery,
  buildToolCatalogContext,
  discoverableToolPool,
  runToolSearch,
  TOOL_DISCOVERY_TOOL_NAME,
  type DiscoverableTool,
  type FunctionToolDeclaration,
} from "./discovery";

export function isToolDiscoveryEnabled(assistant: Assistant): boolean {
  return assistant.enableToolDiscovery === true;
}

/** 当前助手的可发现池(全量 MCP 声明,含已激活)。与组装同源,匹配与目录都吃它。 */
export function discoveryPool(assistant: Assistant): DiscoverableTool[] {
  return discoverableToolPool(openAiMcpTools(assistant) as unknown as FunctionToolDeclaration[]);
}

/** 本轮工具数组:开关开 + 有会话 + 池非空时按激活集裁剪并插入 search_tools;
 *  其余情况与 conversationFunctionTools 逐字一致。
 *  S11:组装前先按实时池清理失效激活项——服务器被禁用/删除、工具或助手覆盖关闭后,
 *  旧名字不会继续占位(重新启用后需重新 search 发现),诊断也不会一直报陈旧失效。 */
export function conversationToolsWithDiscovery(
  assistant: Assistant,
  model: Model | null | undefined,
  conversationId: string | null | undefined,
): FunctionToolDeclaration[] {
  const base = conversationFunctionTools(assistant, model) as unknown as FunctionToolDeclaration[];
  if (!conversationId || !isToolDiscoveryEnabled(assistant)) return base;
  const pool = discoverableToolPool(base);
  const liveNames = new Set(pool.map((tool) => tool.name));
  pruneToolActivation(conversationId, liveNames);
  if (pool.length === 0) return base;
  return applyToolDiscovery(base, new Set(readToolActivation(conversationId).active));
}

/** 系统提示词工具目录段;开关关/无会话/无池 → 空串(不产生任何提示词差异)。 */
export function toolDiscoverySystemContext(
  assistant: Assistant,
  conversationId: string | null | undefined,
): string {
  if (!conversationId || !isToolDiscoveryEnabled(assistant)) return "";
  const pool = discoveryPool(assistant);
  if (pool.length === 0) return "";
  return buildToolCatalogContext(pool, new Set(readToolActivation(conversationId).active));
}

/** search_tools 执行入口(聊天引擎;pi 通路的接入在 S10)。
 *  命中只登记 pending,绝不改本轮请求体——调用方下一轮组装时才看到新 schema。 */
export function runSearchToolsTool(
  assistant: Assistant,
  args: Record<string, JsonValue>,
  context?: { conversationId?: string },
): string {
  if (!isToolDiscoveryEnabled(assistant)) {
    throw new Error(
      `Tool discovery is disabled for this assistant. Stop calling ${TOOL_DISCOVERY_TOOL_NAME}; available tools are already in your tool list.`,
    );
  }
  const conversationId = String(context?.conversationId ?? "").trim();
  if (!conversationId) {
    throw new Error(`${TOOL_DISCOVERY_TOOL_NAME} requires an active conversation.`);
  }
  const pool = discoveryPool(assistant);
  if (pool.length === 0) {
    return `No MCP tools are configured for this assistant; nothing to discover.`;
  }
  const activation = readToolActivation(conversationId);
  const outcome = runToolSearch(pool, new Set(activation.active), args);
  if (outcome.names.length > 0) registerPendingToolActivation(conversationId, outcome.names);
  return outcome.text;
}

// ── S11 诊断 ────────────────────────────────────────────────────────────────

/** 失效原因(机器可读码;文案由前端/日志决定,后端不固化展示措辞)。
 *  - server_missing     当前配置里已没有暴露该名字的服务器(服务器被删/重新同步后工具消失)
 *  - server_not_attached 服务器存在但未挂到当前助手
 *  - server_disabled    服务器总开关关闭
 *  - tool_disabled      工具级开关关闭(全局)
 *  - override_disabled  该助手的工具覆盖关闭
 *  - unknown            配置看似放行但名字仍不在池中(重名遮蔽等边缘),按不可用处理 */
export type ToolActivationInvalidReason =
  | "server_missing"
  | "server_not_attached"
  | "server_disabled"
  | "tool_disabled"
  | "override_disabled"
  | "unknown";

export interface ToolActivationInvalidEntry {
  name: string;
  section: "active" | "pending";
  reason: ToolActivationInvalidReason;
  serverId?: string;
  serverName?: string;
}

export interface ToolDiscoveryDiagnostics {
  enabled: boolean;
  assistantId: string;
  conversationId: string;
  /** 当前实时可发现池大小(开关关闭时为 0)。 */
  poolSize: number;
  /** 持久化激活集(含失效项,见 invalid)。 */
  active: string[];
  pending: string[];
  invalid: ToolActivationInvalidEntry[];
}

/** 与 tools/definitions.openAiMcpTools、tools/mcp.resolveMcpToolServer 的命名规则一致
 *  (mcp__ + 非 [A-Za-z0-9_-] 字符替 _)。诊断只读配置,不参与实际命名。 */
function mcpNameOf(rawToolName: unknown): string {
  return `mcp__${String(rawToolName ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function explainInvalidTool(
  assistant: Assistant,
  name: string,
): Omit<ToolActivationInvalidEntry, "name" | "section"> {
  const attached = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as JsonValue[]).filter(isRecord);
  let notAttached: { serverId: string; serverName: string } | null = null;
  let seenButAllowed = false;
  for (const server of servers) {
    const serverId = String(server.id ?? "");
    const common = isRecord(server.commonOptions) ? server.commonOptions : null;
    const tools = common && Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const tool = tools.find((item) => mcpNameOf(item.name) === name);
    if (!tool) continue;
    const serverName = String(common?.name ?? serverId);
    if (!attached.has(serverId)) {
      notAttached ??= { serverId, serverName };
      continue;
    }
    if (!common || common.enable === false) return { reason: "server_disabled", serverId, serverName };
    if (tool.enable === false) return { reason: "tool_disabled", serverId, serverName };
    if (getMcpToolOverride(assistant, serverId, String(tool.name ?? ""))?.enable === false) {
      return { reason: "override_disabled", serverId, serverName };
    }
    seenButAllowed = true;
  }
  if (notAttached) return { reason: "server_not_attached", ...notAttached };
  return { reason: seenButAllowed ? "unknown" : "server_missing" };
}

/** 纯诊断:给定激活集与实时可见名字,列出失效项及原因。不读写库、不触网。 */
export function diagnoseToolActivation(
  assistant: Assistant,
  activation: ToolActivationState,
  liveNames: ReadonlySet<string>,
): ToolActivationInvalidEntry[] {
  const invalid: ToolActivationInvalidEntry[] = [];
  for (const name of activation.active) {
    if (!liveNames.has(name)) invalid.push({ name, section: "active", ...explainInvalidTool(assistant, name) });
  }
  for (const name of activation.pending) {
    if (!liveNames.has(name)) invalid.push({ name, section: "pending", ...explainInvalidTool(assistant, name) });
  }
  return invalid;
}

/** 诊断装配(显式传激活集,便于单测):实时池由当前助手配置计算。
 *  开关关闭时激活集处于休眠(再次开启会恢复),不判失效——invalid 恒为空。 */
export function buildToolDiscoveryDiagnostics(
  assistant: Assistant,
  conversationId: string | null | undefined,
  activation: ToolActivationState,
): ToolDiscoveryDiagnostics {
  const enabled = isToolDiscoveryEnabled(assistant);
  const pool = enabled ? discoveryPool(assistant) : [];
  const liveNames = new Set(pool.map((tool) => tool.name));
  return {
    enabled,
    assistantId: assistant.id,
    conversationId: String(conversationId ?? ""),
    poolSize: pool.length,
    active: [...activation.active],
    pending: [...activation.pending],
    invalid: enabled ? diagnoseToolActivation(assistant, activation, liveNames) : [],
  };
}

/** 生产诊断口:读当前会话激活集再组装;无会话 → 空激活集。 */
export function toolDiscoveryDiagnostics(
  assistant: Assistant,
  conversationId: string | null | undefined,
): ToolDiscoveryDiagnostics {
  const activation = conversationId ? readToolActivation(conversationId) : emptyToolActivation();
  return buildToolDiscoveryDiagnostics(assistant, conversationId, activation);
}
