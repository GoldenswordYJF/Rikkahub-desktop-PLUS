// pi-engine/tool-discovery.ts — S10 pi 通路工具发现行(全集注册 + 子集激活)
//
// 聊天通路的发现行靠"请求体工具数组裁剪";pi 通路的原生等价物是
// registry 全集 + session.setActiveToolsByName 只激活子集:
//  - 全部工具(含 MCP)照常注册为 customTools——registry 里有才可能被激活;
//  - 开关开启且有 MCP 池时,首轮只激活常驻核心 + search_tools,MCP schema 不进请求;
//  - search_tools 命中只登记 conversation 级 pending(与聊天通路同一份激活集);
//  - runner 在 pi turn_end(工具批执行完、下次 LLM 请求前)调用 refresh:
//    pending → active,并按新名单 setActiveToolsByName(原生"下一轮生效");
//  - 关闭开关/无会话/无池 → 原数组原样返回、不调 setActiveToolsByName,行为与引入前逐字一致。
//
// 子智能体不继承父激活数组:allowedTools ∩ 父激活集在 subagent-tools 装配处重算
// (MCP 不在白名单,现状恒被排除;交集规则防白名单未来扩容时越权)。

import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant, JsonValue } from "../foundation/types";
import {
  promotePendingToolActivation,
  pruneToolActivation,
  readToolActivation,
  registerPendingToolActivation,
} from "../conversations/tool-activation";
import {
  discoverableToolPool,
  runToolSearch,
  searchToolsDeclaration,
  TOOL_DISCOVERY_TOOL_NAME,
  type DiscoverableTool,
  type FunctionToolDeclaration,
} from "../tools/discovery";
import { isToolDiscoveryEnabled } from "../tools/discovery-store";

/** pi ToolDefinition → 发现池:MCP 判定/池结构复用聊天通路同一份纯逻辑
 *  (isMcpFunctionTool 认 mcp__ 前缀)。描述走匹配文本,不进请求体。 */
export function piDiscoveryPool(tools: readonly ToolDefinition[]): DiscoverableTool[] {
  return discoverableToolPool(
    tools.map(
      (tool): FunctionToolDeclaration => ({
        type: "function",
        function: { name: tool.name, description: tool.description },
      }),
    ),
  );
}

/** pi 侧 search_tools 工具定义。匹配/文本/登记语义与聊天通路共用 tools/discovery
 *  纯逻辑;池用"实际注册进 pi 的工具"而非再查一次助手配置——注册面与可发现面
 *  必须是同一份(执行体不信任可能漂移的第二来源)。 */
function searchToolsDefinition(
  assistant: Assistant,
  conversationId: string,
  pool: readonly DiscoverableTool[],
): ToolDefinition {
  const declaration = searchToolsDeclaration().function;
  return {
    name: TOOL_DISCOVERY_TOOL_NAME,
    label: TOOL_DISCOVERY_TOOL_NAME,
    description: String(declaration.description ?? ""),
    parameters: declaration.parameters as ToolDefinition["parameters"],
    // 与 general-tools 同纪律:无 promptSnippet(不进 pi Available tools 清单);
    // 系统面的工具目录段负责让模型知道它存在。
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      // 生成中途切走开关(会话快照外的手动改动)时给明确拒绝,不静默返回空命中。
      if (!isToolDiscoveryEnabled(assistant)) {
        throw new Error(
          `Tool discovery is disabled for this assistant. Stop calling ${TOOL_DISCOVERY_TOOL_NAME}; available tools are already in your tool list.`,
        );
      }
      const activation = readToolActivation(conversationId);
      const outcome = runToolSearch(pool, new Set(activation.active), (params ?? {}) as Record<string, JsonValue>);
      if (outcome.names.length > 0) registerPendingToolActivation(conversationId, outcome.names);
      return { content: [{ type: "text" as const, text: outcome.text }], details: {} };
    },
  };
}

export interface PiToolDiscoveryAssembly {
  /** 注册进 pi registry 的工具全集(发现开启时含 search_tools;关闭时原样返回)。 */
  tools: ToolDefinition[];
  /** 首次 prompt 前应激活的工具名。null = 未介入(开关关/无会话/无池)——
   *  runner 不调 setActiveToolsByName,行为与引入前逐字一致。 */
  initialActiveNames: string[] | null;
  /** turn_end 轮边界刷新:提升 pending 并返回最新激活名单;无变化 → null。 */
  refreshActiveNames?: () => string[] | null;
}

/** 按"常驻核心 + 已激活 MCP + search_tools"计算激活名(保持 base 顺序,前缀稳定:
 *  激活只改变 MCP 段与其后的数组尾部)。 */
function activeNamesFor(
  tools: readonly ToolDefinition[],
  poolNames: ReadonlySet<string>,
  active: ReadonlySet<string>,
): string[] {
  return tools.filter((tool) => !poolNames.has(tool.name) || active.has(tool.name)).map((tool) => tool.name);
}

/** 会话装配入口:返回注册全集 + 首轮激活名 + 轮边界刷新闭包。
 *  调用方(baseTools)已按助手装配好工作区/通用/MCP/子智能体工具。 */
export function assemblePiToolDiscovery(
  baseTools: readonly ToolDefinition[],
  assistant: Assistant,
  conversationId: string | null | undefined,
): PiToolDiscoveryAssembly {
  const untouched: PiToolDiscoveryAssembly = { tools: baseTools as ToolDefinition[], initialActiveNames: null };
  if (!conversationId || !isToolDiscoveryEnabled(assistant)) return untouched;
  const pool = piDiscoveryPool(baseTools);
  const poolNames = new Set(pool.map((tool) => tool.name));
  // S11:装配时按"本次注册面"清理失效激活项(服务器禁用/删除、工具或覆盖关闭会让
  // 名字不再出现在 baseTools 里);池清空时同样清空激活集,重新启用后需重新发现。
  pruneToolActivation(conversationId, poolNames);
  if (pool.length === 0) return untouched;
  // search_tools 插在 MCP 段首位(与聊天通路同序):激活只改变其后缀,前缀稳定。
  const firstMcp = baseTools.findIndex((tool) => poolNames.has(tool.name));
  const tools = [...baseTools];
  tools.splice(firstMcp < 0 ? tools.length : firstMcp, 0, searchToolsDefinition(assistant, conversationId, pool));
  const namesFor = (active: readonly string[]) => activeNamesFor(tools, poolNames, new Set(active));
  return {
    tools,
    initialActiveNames: namesFor(readToolActivation(conversationId).active),
    refreshActiveNames: () => {
      const before = readToolActivation(conversationId);
      if (before.pending.length === 0) return null;
      if (promotePendingToolActivation(conversationId).length === 0) return null;
      // S11:提升后再按注册面清理一次——pending 若在登记与提升之间被关掉,不进入激活名。
      pruneToolActivation(conversationId, poolNames);
      return namesFor(readToolActivation(conversationId).active);
    },
  };
}
