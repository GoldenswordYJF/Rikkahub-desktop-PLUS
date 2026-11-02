// tools/discovery.test.ts — S9 工具发现行纯逻辑回归
// 覆盖:激活集组装顺序/前缀稳定性、关键词匹配确定性、select 直选、目录文本稳定性。
import { describe, expect, test } from "bun:test";
import {
  applyToolDiscovery,
  buildToolCatalogContext,
  clampMaxResults,
  discoverableToolPool,
  parseSelectQuery,
  runToolSearch,
  searchDiscoverableTools,
  searchToolsDeclaration,
  TOOL_DISCOVERY_DEFAULT_RESULTS,
  TOOL_DISCOVERY_MAX_RESULTS,
  TOOL_DISCOVERY_TOOL_NAME,
  type DiscoverableTool,
  type FunctionToolDeclaration,
} from "./discovery";

function fn(name: string, description = ""): FunctionToolDeclaration {
  return { type: "function", function: { name, description, parameters: { type: "object", properties: {} } } };
}

const core = [fn("search_web", "Search the web"), fn("save_memory", "Remember facts"), fn("use_skill", "Load a skill")];
const mcpA = fn("mcp__github__create_issue", "Create a GitHub issue in a repository");
const mcpB = fn("mcp__db__query", "Run a read-only SQL query against the database");
const mcpC = fn("mcp__github__list_prs", "List pull requests for a repository");
const subagent = fn("subagent_dispatch", "Delegate work");

const base = [...core, mcpA, mcpB, mcpC, subagent];
const pool: DiscoverableTool[] = discoverableToolPool(base);

describe("applyToolDiscovery", () => {
  test("未激活的 MCP 工具不出现在数组；search_tools 固定插在 MCP 段首位", () => {
    const tools = applyToolDiscovery(base, new Set(["mcp__db__query"]));
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "search_web",
      "save_memory",
      "use_skill",
      TOOL_DISCOVERY_TOOL_NAME,
      "mcp__db__query",
      "subagent_dispatch",
    ]);
    // 已激活工具复用原声明对象(S8 的 description 截断/参数展开不再重算)。
    expect(tools.find((tool) => tool.function.name === "mcp__db__query")).toBe(mcpB);
  });

  test("前缀稳定性：激活更多工具只改变 search_tools 之后的部分", () => {
    const one = applyToolDiscovery(base, new Set(["mcp__db__query"]));
    const two = applyToolDiscovery(base, new Set(["mcp__db__query", "mcp__github__list_prs"]));
    const prefix = (tools: FunctionToolDeclaration[]) => tools.slice(0, 4).map((tool) => tool.function.name);
    expect(prefix(two)).toEqual(prefix(one));
    expect(two.slice(4, 6).map((tool) => tool.function.name)).toEqual(["mcp__db__query", "mcp__github__list_prs"]);
  });

  test("无 MCP 池时原数组原样返回(关闭开关路径的零差异保证)", () => {
    const noMcp = [...core, subagent];
    expect(applyToolDiscovery(noMcp, new Set())).toBe(noMcp as FunctionToolDeclaration[]);
  });

  test("池存在但全部未激活：只剩核心工具 + search_tools", () => {
    const tools = applyToolDiscovery(base, new Set());
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "search_web",
      "save_memory",
      "use_skill",
      TOOL_DISCOVERY_TOOL_NAME,
      "subagent_dispatch",
    ]);
  });

  test("search_tools 声明形状：名字/必填/上限", () => {
    const declaration = searchToolsDeclaration();
    expect(declaration.function.name).toBe(TOOL_DISCOVERY_TOOL_NAME);
    expect(declaration.function.parameters).toMatchObject({
      required: ["query"],
      properties: { max_results: { minimum: 1, maximum: 5 } },
    });
  });
});

describe("匹配与直选", () => {
  test("整名命中优先，同分按字典序；maxResults 生效", () => {
    expect(searchDiscoverableTools(pool, "mcp__github__create_issue", 3).map((tool) => tool.name))
      .toEqual(["mcp__github__create_issue"]);
    const github = searchDiscoverableTools(pool, "github", 5).map((tool) => tool.name);
    expect(github).toEqual(["mcp__github__create_issue", "mcp__github__list_prs"]);
    expect(searchDiscoverableTools(pool, "repository", 1)).toHaveLength(1);
  });

  test("无命中返回空；空查询不算命中", () => {
    expect(searchDiscoverableTools(pool, "kubernetes helm", 3)).toEqual([]);
    expect(searchDiscoverableTools(pool, "   ", 3)).toEqual([]);
  });

  test("select: 解析 / 大小写不敏感 / 未知名字单列", () => {
    expect(parseSelectQuery("select: mcp__db__query, mcp__github__list_prs")).toEqual([
      "mcp__db__query",
      "mcp__github__list_prs",
    ]);
    expect(parseSelectQuery("github issue")).toBeNull();

    const outcome = runToolSearch(pool, new Set(), {
      query: "select:MCP__DB__QUERY, mcp__nope__x",
    });
    expect(outcome.names).toEqual(["mcp__db__query"]);
    expect(outcome.text).toContain("mcp__db__query");
    expect(outcome.text).toContain("Unknown tool(s): mcp__nope__x");
    expect(outcome.text).toContain("next round");
  });

  test("关键词命中只登记未激活工具；已激活只提示直接调用", () => {
    const outcome = runToolSearch(pool, new Set(["mcp__db__query"]), { query: "database" });
    expect(outcome.names).toEqual([]);
    expect(outcome.text).toContain("(already loaded)");
    expect(outcome.text).toContain("call them directly");

    const fresh = runToolSearch(pool, new Set(), { query: "github", max_results: 1 });
    expect(fresh.names).toEqual(["mcp__github__create_issue"]);
    expect(fresh.text).toContain("next round");
  });

  test("max_results 归一：1–5，缺省 3", () => {
    expect(clampMaxResults(undefined)).toBe(TOOL_DISCOVERY_DEFAULT_RESULTS);
    expect(clampMaxResults(0)).toBe(1);
    expect(clampMaxResults(99)).toBe(TOOL_DISCOVERY_MAX_RESULTS);
    expect(clampMaxResults("2")).toBe(2);
    expect(clampMaxResults("abc")).toBe(TOOL_DISCOVERY_DEFAULT_RESULTS);
  });

  test("结果文本一行一条、描述紧凑化", () => {
    const outcome = runToolSearch(pool, new Set(), { query: "issue" });
    expect(outcome.text).toContain("- mcp__github__create_issue — Create a GitHub issue in a repository");
    expect(outcome.text).not.toContain("\n\n");
  });
});

describe("系统提示词工具目录", () => {
  test("同一激活集逐字稳定；激活集变化才换段", () => {
    const first = buildToolCatalogContext(pool, new Set(["mcp__db__query"]));
    const second = buildToolCatalogContext(pool, new Set(["mcp__db__query"]));
    expect(first).toBe(second);
    expect(first).toContain("Loaded MCP tools (callable now): mcp__db__query");
    expect(first).toContain("Hidden MCP tools (2): mcp__github__create_issue, mcp__github__list_prs");
    const all = buildToolCatalogContext(pool, new Set(pool.map((tool) => tool.name)));
    expect(all).toContain("All 3 MCP tool(s)");
  });

  test("空池返回空串；隐藏名单超上限只给计数", () => {
    expect(buildToolCatalogContext([], new Set())).toBe("");
    const many = Array.from({ length: 65 }, (_, index) => ({ name: `mcp__s__t${index}`, description: "" }));
    const text = buildToolCatalogContext(many, new Set());
    expect(text).toContain("Hidden MCP tools (65)");
    expect(text).toContain("(+5 more)");
  });
});
