// tools/discovery.ts — S9 工具发现行(纯函数层)
//
// 目的:把"模型每轮背多少 MCP schema"从 O(工具数) 降到 O(常驻核心 + 已激活)。
// 本期只把 MCP 工具放进可发现池——核心工具(search/local/skill/subagent)常驻,
// workspace 工具走 pi 工作区、不在此列。
//
// 分工:
//  - 本文件:声明生成 / 过滤组装 / 确定性关键词匹配 / 工具目录文本。零 IO、零 DB,
//    可直接单测(匹配不调模型,结果可复现)。
//  - tools/discovery-store.ts:接全局 state 与会话激活集(读写 SQLite)。
//
// 纪律:
//  - `applyToolDiscovery` 只在池非空时介入;无 MCP 工具 → 原数组原样返回(调用方
//    关闭开关时也根本不会调用本函数),关闭时行为与引入前逐字一致。
//  - search_tools 的插入位置固定为"MCP 段首位":激活新工具只改变该位置之后的数组,
//    激活前的前缀(search/local/skill/search_tools)保持稳定,便于前缀缓存命中。
//  - 命中只登记 pending,由轮边界提升;本文件不碰请求体。

import type { JsonValue } from "../foundation/types";

export const TOOL_DISCOVERY_TOOL_NAME = "search_tools";
export const TOOL_DISCOVERY_DEFAULT_RESULTS = 3;
export const TOOL_DISCOVERY_MAX_RESULTS = 5;
/** 系统提示词目录里最多列出的隐藏工具名数量(超出只给计数,控制常量体积)。 */
const CATALOG_MAX_HIDDEN_NAMES = 60;
/** search_tools 返回结果的单条描述截断长度(一行)。 */
const MATCH_DESCRIPTION_CHARS = 240;

/** OpenAI function tool 的最小结构(三家装配前同源)。 */
export interface FunctionToolDeclaration {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    [key: string]: unknown;
  };
}

export interface DiscoverableTool {
  name: string;
  description: string;
}

export function isFunctionTool(value: unknown): value is FunctionToolDeclaration {
  return typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "function"
    && typeof (value as { function?: { name?: unknown } }).function === "object"
    && (value as { function?: { name?: unknown } }).function !== null
    && typeof (value as { function?: { name?: unknown } }).function?.name === "string";
}

export function isMcpFunctionTool(value: unknown): value is FunctionToolDeclaration {
  return isFunctionTool(value) && value.function.name.startsWith("mcp__");
}

/** 当前基础工具集里的可发现池(全量 MCP 声明;含已激活,调用方按激活集过滤)。 */
export function discoverableToolPool(baseTools: readonly unknown[]): DiscoverableTool[] {
  return baseTools.filter(isMcpFunctionTool).map((tool) => ({
    name: tool.function.name,
    description: String(tool.function.description ?? ""),
  }));
}

/** 发现行声明。max_results 上限 5:一次召回太多等于把 prompt 又背回去。 */
export function searchToolsDeclaration(): FunctionToolDeclaration {
  return {
    type: "function",
    function: {
      name: TOOL_DISCOVERY_TOOL_NAME,
      description: `Find and load additional MCP tools that are not loaded yet to save context.
Use a short keyword query describing what you need (e.g. "create github issue", "query database").
Matches are registered and become callable from the NEXT round; call them by full name then.
Use "select:<full tool name>" (comma-separated for several) when you already know the exact name.
Tools already loaded do not need to be searched again.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords to match tool names/descriptions, or select:<full tool name>[,<name>...]",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: TOOL_DISCOVERY_MAX_RESULTS,
            description: `How many tools to load (1-${TOOL_DISCOVERY_MAX_RESULTS}, default ${TOOL_DISCOVERY_DEFAULT_RESULTS}).`,
          },
        },
        required: ["query"],
      },
    },
  };
}

/** 按激活集组装:未激活 MCP 工具不携带 schema,search_tools 固定插在 MCP 段首位。
 *  池为空(没有 MCP 工具)时原数组原样返回——调用方无需先判池。 */
export function applyToolDiscovery(
  baseTools: readonly FunctionToolDeclaration[],
  activeNames: ReadonlySet<string>,
): FunctionToolDeclaration[] {
  const hasPool = baseTools.some(isMcpFunctionTool);
  if (!hasPool) return baseTools as FunctionToolDeclaration[];
  const result: FunctionToolDeclaration[] = [];
  let inserted = false;
  for (const tool of baseTools) {
    if (!isMcpFunctionTool(tool)) {
      result.push(tool);
      continue;
    }
    if (!inserted) {
      result.push(searchToolsDeclaration());
      inserted = true;
    }
    if (activeNames.has(tool.function.name)) result.push(tool);
  }
  if (!inserted) result.push(searchToolsDeclaration());
  return result;
}

export function clampMaxResults(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return TOOL_DISCOVERY_DEFAULT_RESULTS;
  return Math.min(TOOL_DISCOVERY_MAX_RESULTS, Math.max(1, Math.floor(parsed)));
}

/** `select:<全名>[,<全名>...]` 直选语法;非 select 形式返回 null。 */
export function parseSelectQuery(query: string): string[] | null {
  const match = /^select\s*:\s*(.*)$/i.exec(query.trim());
  if (!match) return null;
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** 确定性关键词匹配(不调模型):
 *  整串出现在工具名 → +100;名字命中词 → +10/词;描述命中词 → +1/词。
 *  同分按名字字典序,保证同一输入在不同轮/不同进程结果一致。 */
export function searchDiscoverableTools(
  pool: readonly DiscoverableTool[],
  query: string,
  maxResults: number,
): DiscoverableTool[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = tokenize(normalized);
  const scored: Array<{ tool: DiscoverableTool; score: number }> = [];
  for (const tool of pool) {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    if (name.includes(normalized)) score += 100;
    for (const token of tokens) {
      if (name.includes(token)) score += 10;
      if (description.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0;
  });
  return scored.slice(0, maxResults).map((entry) => entry.tool);
}

export interface ToolSearchOutcome {
  /** 回灌给模型的文本(工具结果)。 */
  text: string;
  /** 本次命中、供调用方登记 pending 的工具全名。 */
  names: string[];
}

function firstLine(description: string, maxChars = MATCH_DESCRIPTION_CHARS): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatMatchLine(tool: DiscoverableTool, active: boolean): string {
  const description = firstLine(tool.description);
  return `- ${tool.name}${active ? " (already loaded)" : ""}${description ? ` — ${description}` : ""}`;
}

/** search_tools 的纯执行体:解析 select/关键词 → 命中列表 → 回灌文本。
 *  activeNames 只影响文案(已加载的不重复登记);不满足条件的查询返回空命中 + 指引。 */
export function runToolSearch(
  pool: readonly DiscoverableTool[],
  activeNames: ReadonlySet<string>,
  args: Record<string, JsonValue>,
): ToolSearchOutcome {
  const rawQuery = String(args.query ?? "").trim();
  if (!rawQuery) {
    return {
      text: "search_tools needs a non-empty `query` (keywords, or select:<full tool name>).",
      names: [],
    };
  }
  const limit = clampMaxResults(args.max_results);
  const selected = parseSelectQuery(rawQuery);
  if (selected) {
    if (selected.length === 0) {
      return { text: "select: needs at least one full tool name, e.g. select:mcp__github__create_issue.", names: [] };
    }
    const poolByLower = new Map(pool.map((tool) => [tool.name.toLowerCase(), tool]));
    const found: DiscoverableTool[] = [];
    const unknown: string[] = [];
    for (const name of selected) {
      const tool = poolByLower.get(name.toLowerCase());
      if (tool) {
        if (!found.some((item) => item.name === tool.name)) found.push(tool);
      } else {
        unknown.push(name);
      }
    }
    const limited = found.slice(0, limit);
    const lines = limited.map((tool) => formatMatchLine(tool, activeNames.has(tool.name)));
    if (limited.length === 0 && unknown.length === 0) {
      return { text: "No tool was selected.", names: [] };
    }
    const tail: string[] = [];
    const pendingNames = limited.filter((tool) => !activeNames.has(tool.name)).map((tool) => tool.name);
    if (pendingNames.length) {
      tail.push(`Loaded from the next round; call by full name then.`);
    } else if (limited.length) {
      tail.push("Already loaded; call them directly.");
    }
    if (unknown.length) {
      tail.push(`Unknown tool(s): ${unknown.join(", ")}. Use a keyword query to search instead.`);
    }
    return {
      text: [lines.length ? `Selected ${lines.length} tool(s):` : "", ...lines, ...tail].filter(Boolean).join("\n"),
      names: pendingNames,
    };
  }

  const matches = searchDiscoverableTools(pool, rawQuery, limit);
  if (matches.length === 0) {
    return {
      text: `No matching tools for "${rawQuery}". ${pool.length} MCP tool(s) exist; try different keywords or select:<full name>.`,
      names: [],
    };
  }
  const lines = matches.map((tool) => formatMatchLine(tool, activeNames.has(tool.name)));
  const pendingNames = matches.filter((tool) => !activeNames.has(tool.name)).map((tool) => tool.name);
  const tail = pendingNames.length
    ? "Loaded from the next round; call by full name then."
    : "Already loaded; call them directly.";
  return {
    text: [`Found ${matches.length} tool(s):`, ...lines, tail].join("\n"),
    names: pendingNames,
  };
}

/** 系统提示词的工具目录段。内容只取决于"池 + 激活集"——同一激活集下逐字稳定,
 *  不会因为轮次/时间漂移破坏前缀缓存;激活集变化才换段。 */
export function buildToolCatalogContext(
  pool: readonly DiscoverableTool[],
  activeNames: ReadonlySet<string>,
): string {
  if (pool.length === 0) return "";
  const active = pool.filter((tool) => activeNames.has(tool.name)).map((tool) => tool.name);
  const hidden = pool.filter((tool) => !activeNames.has(tool.name)).map((tool) => tool.name);
  if (hidden.length === 0) {
    return [
      "**Tool catalog**",
      `All ${pool.length} MCP tool(s) for this assistant are loaded: ${active.join(", ")}.`,
    ].join("\n");
  }
  const shown = hidden.slice(0, CATALOG_MAX_HIDDEN_NAMES);
  const more = hidden.length - shown.length;
  const loadedLine = active.length
    ? `Loaded MCP tools (callable now): ${active.join(", ")}`
    : "No MCP tools are loaded yet.";
  return [
    "**Tool catalog**",
    loadedLine,
    `Hidden MCP tools (${hidden.length}): ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    `Call \`${TOOL_DISCOVERY_TOOL_NAME}\` with keywords or \`select:<full name>\` to load the ones you need; loaded tools become callable from the next round.`,
  ].join("\n");
}
