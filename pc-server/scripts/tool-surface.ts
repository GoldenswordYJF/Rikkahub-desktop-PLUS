// scripts/tool-surface.ts — 工具面计量(S1,docs/plan-ops-tool-surface.md)
//
// 目的:把"模型每轮要背多少工具"变成可重复的数字,作为 S8/S9/S10 改动前后的验收依据。
// 做法:不起服务器、不读写 state.json,用固定 fixtures 组装与生产同源的声明
// (tools/definitions + workspace/tools 内核),分别计量两条生成通路:
//   chat = search + local + skill + MCP + subagent + workspace
//   pi   = search + local(save_memory/ask_user) + MCP + workspace + 系统提示词增量
// 输出:每个工具的 JSON 字节数、估算 token(chars/4,英文近似)、按来源聚合、Top N。
//
// 运行:bun run scripts/tool-surface.ts [--json] [--mcp 40] [--servers 4] [--skills 12] [--top 10]
//       [--desc 4000] [--cap-descriptions]
// S8 对比:--desc N 生成 N 字符的超长 MCP description 样本;--cap-descriptions 打开
// description 截断(与线上 settings.workspaceTools.mcpDescriptionCap 同一实现),
// 报告里另列 before/after 体积与命中工具数。
// S9/S10 对比:恒输出 [discovery] 块——用线上同一份 applyToolDiscovery /
// buildToolCatalogContext 计算"发现开启、首轮零激活"时的 tools 数组与目录段,
// 与"发现关闭(全量 MCP)"账单逐项对照;开关本身不读写 state。
// 注意:token 是廉价估算,仅用于相对比较;绝对 token 以供应商 usage 为准。

import type { Assistant, JsonValue, SkillMetadata, State } from "../foundation/types";
import { setState } from "../persistence/json-store";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools, openAiSkillTools, openAiSubagentTool } from "../tools/definitions";
import { capMcpToolDescription, MCP_DESCRIPTION_MAX_CHARS } from "../tools/mcp-description";
import { inlineMcpToolSchema } from "../tools/schema-inline";
import {
  applyToolDiscovery,
  buildToolCatalogContext,
  discoverableToolPool,
  type FunctionToolDeclaration,
} from "../tools/discovery";
import { PROMPT_GUIDELINES, PROMPT_SNIPPETS } from "../pi-engine/workspace-tools";
import { createBashTool } from "../workspace/tools/bash";
import { createEditTool } from "../workspace/tools/edit";
import { createFindTool } from "../workspace/tools/find";
import { createGrepTool } from "../workspace/tools/grep";
import { createLsTool } from "../workspace/tools/ls";
import { createReadTool } from "../workspace/tools/read";
import { createWriteTool } from "../workspace/tools/write";
import { createReadFilesTool } from "../workspace/ops/read-files";

type Source = "workspace" | "search" | "local" | "skill" | "mcp" | "subagent" | "discovery";

interface ToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

type SourcedDecl = ToolDecl & { source: Source };

interface MeasuredTool extends ToolDecl {
  source: Source;
  /** {name,description,parameters} 序列化后的 UTF-8 字节数(进 API tools 数组的体积) */
  bytes: number;
  descBytes: number;
  schemaBytes: number;
  /** 廉价 token 估算(chars/4;英文近似,中文会低估) */
  tokens: number;
}

interface SurfaceReport {
  label: string;
  tools: MeasuredTool[];
  totalBytes: number;
  totalTokens: number;
  bySource: Record<string, { count: number; bytes: number; tokens: number }>;
  /** pi 专用:不进 tools 数组、但每轮都进系统提示词的增量(工具摘要/指引) */
  promptBytes: number;
  promptTokens: number;
  top: MeasuredTool[];
  longestDescriptions: MeasuredTool[];
}

function numericArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const parsed = Number(process.argv[idx + 1]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

const JSON_OUT = process.argv.includes("--json");
const MCP_TOOL_COUNT = numericArg("mcp", 40);
const MCP_SERVER_COUNT = Math.max(1, numericArg("servers", 4));
const SKILL_COUNT = numericArg("skills", 12);
const TOP_N = Math.max(1, numericArg("top", 10));
/** S8 样本:每个 MCP 工具生成 N 字符 description(0 = 用固定短样本)。 */
const MCP_DESC_CHARS = numericArg("desc", 0);
/** S8:按线上开关同一实现裁剪 description(默认关 = 历史行为)。 */
const CAP_DESCRIPTIONS = process.argv.includes("--cap-descriptions");

// ----- fixtures(固定形状,只能通过参数改变规模) -----

function makeSkills(count: number): SkillMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `fixture-skill-${i + 1}`,
    description: `Fixture skill ${i + 1}: a representative one-line description of what this skill does (used to measure the skills block in the system prompt).`,
  })) as SkillMetadata[];
}

// 共享 $defs 的 MCP schema:用于量化 schema-inline 的展开膨胀(S8 证据)。
const MCP_DEFS = {
  Query: {
    type: "object",
    properties: {
      text: { type: "string", description: "Free-text query" },
      limit: { type: "integer", description: "Maximum number of records" },
    },
    required: ["text"],
  },
  Location: {
    type: "object",
    properties: {
      latitude: { type: "number" },
      longitude: { type: "number" },
      radius_meters: { type: "integer" },
    },
  },
} as const;

function makeMcpSchema(): Record<string, unknown> {
  return {
    type: "object",
    $defs: MCP_DEFS,
    properties: {
      query: { $ref: "#/$defs/Query" },
      filters: { type: "array", items: { $ref: "#/$defs/Query" } },
      location: { $ref: "#/$defs/Location" },
      fallback_location: { $ref: "#/$defs/Location" },
      notes: { type: "string", description: "Optional free-form notes" },
    },
    required: ["query"],
  };
}

function makeMcpDescription(index: number, length: number): string {
  const base = `Fixture MCP tool ${index + 1}: searches records with structured filters and returns paginated matches. Use when the user asks about records, history, or indexed documents from this source.`;
  if (length <= 0 || length <= base.length) return base;
  const padding = " Additional guidance mirrors long vendor documentation: prefer narrow filters, page through results, and never request more than the caller needs.";
  let text = base;
  while (text.length < length) text += padding;
  // 尾部塞一条关键说明,验证裁剪后仍保留行为约束(text 会截到 length,先留足空间)。
  const keyNote = " IMPORTANT: Always pass the documented filter object; unknown fields are rejected.";
  text = text.slice(0, Math.max(base.length, length - keyNote.length)) + keyNote;
  return text.slice(0, length);
}

function makeMcpServers(toolCount: number, serverCount: number): Array<Record<string, JsonValue>> {
  const perServer = Math.ceil(toolCount / serverCount);
  return Array.from({ length: serverCount }, (_, s) => {
    const tools: JsonValue[] = [];
    for (let i = s * perServer; i < Math.min(toolCount, (s + 1) * perServer); i++) {
      tools.push({
        name: `records_search_${i + 1}`,
        description: makeMcpDescription(i, MCP_DESC_CHARS),
        inputSchema: makeMcpSchema() as unknown as JsonValue,
        enable: true,
      });
    }
    return {
      id: `fixture-server-${s + 1}`,
      commonOptions: { name: `Fixture Server ${s + 1}`, enable: true, tools },
    };
  });
}

const skills = makeSkills(SKILL_COUNT);
const mcpServers = makeMcpServers(MCP_TOOL_COUNT, MCP_SERVER_COUNT);
const memorySettings = {
  globalEnabled: true,
  writeStrategy: "always_global",
  dedupEnabled: true,
  memoryModelThinkingEnabled: false,
};

// write-policy.canAssistantWriteMemory 读全局 state;计量脚本用最小 state 满足它,不落盘。
setState({ settings: { memorySettings } } as unknown as State);

const assistant = {
  id: "fixture-assistant",
  localTools: ["time_info", "clipboard", "tts", "ask_user"],
  enableMemory: true,
  memoryWriteScope: "tool_default_assistant",
  enabledSkills: skills.map((skill) => skill.name),
  mcpServers: mcpServers.map((server) => String(server.id)),
} as unknown as Assistant;

// ----- 声明装配(与生产同源:definitions 纯函数 + 工作区内核) -----

function fromOpenAi(decls: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>, source: Source): SourcedDecl[] {
  return decls.map((decl) => ({
    name: decl.function.name,
    description: String(decl.function.description ?? ""),
    parameters: decl.function.parameters ?? { type: "object", properties: {} },
    source,
  }));
}

function workspaceDecls(names: readonly string[]): SourcedDecl[] {
  // description/parameters 与挂载层逐字同源;这里不执行,只取声明。
  const cwd = process.cwd();
  const byName: Record<string, ToolDecl> = {
    read: createReadTool(cwd) as unknown as ToolDecl,
    read_files: createReadFilesTool(cwd) as unknown as ToolDecl,
    bash: createBashTool(cwd) as unknown as ToolDecl,
    edit: createEditTool(cwd) as unknown as ToolDecl,
    write: createWriteTool(cwd) as unknown as ToolDecl,
    grep: createGrepTool(cwd) as unknown as ToolDecl,
    find: createFindTool(cwd) as unknown as ToolDecl,
    ls: createLsTool(cwd) as unknown as ToolDecl,
  };
  return names.map((name) => ({ ...byName[name]!, source: "workspace" as Source }));
}

const searchDecls: SourcedDecl[] = fromOpenAi(openAiSearchTools(true), "search");
const localDecls: SourcedDecl[] = fromOpenAi(openAiLocalTools(assistant, memorySettings as never, { structuredIntake: true }), "local");
const skillDecls: SourcedDecl[] = fromOpenAi(openAiSkillTools(assistant, () => skills), "skill");
const mcpDecls: SourcedDecl[] = [
  ...fromOpenAi(openAiMcpTools(assistant, mcpServers, { descriptionCap: CAP_DESCRIPTIONS }), "mcp"),
  // openAiMcpTools 已内联;这里补一行原始 schema 体积,单独在 mcpInline 报告。
];
const subagentDecls: SourcedDecl[] = fromOpenAi(openAiSubagentTool({ enabled: true, maxConcurrency: 4, maxTasksPerCall: 6 } as never), "subagent");
const wsWithBash = workspaceDecls(["read", "read_files", "bash", "edit", "write"]);
const wsFallback = workspaceDecls(["read", "read_files", "edit", "write", "grep", "find", "ls"]);

// ----- 计量 -----

function measure(decl: SourcedDecl): MeasuredTool {
  const payload = JSON.stringify({ name: decl.name, description: decl.description, parameters: decl.parameters });
  const chars = payload.length;
  return {
    ...decl,
    bytes: Buffer.byteLength(payload, "utf8"),
    descBytes: Buffer.byteLength(decl.description, "utf8"),
    schemaBytes: Buffer.byteLength(JSON.stringify(decl.parameters), "utf8"),
    tokens: Math.ceil(chars / 4),
  };
}

function buildSurface(label: string, decls: SourcedDecl[], promptText: string): SurfaceReport {
  const tools = decls.map(measure);
  const totalBytes = tools.reduce((sum, tool) => sum + tool.bytes, 0);
  const totalTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  const bySource: SurfaceReport["bySource"] = {};
  for (const tool of tools) {
    const bucket = (bySource[tool.source] ??= { count: 0, bytes: 0, tokens: 0 });
    bucket.count += 1;
    bucket.bytes += tool.bytes;
    bucket.tokens += tool.tokens;
  }
  return {
    label,
    tools,
    totalBytes,
    totalTokens,
    bySource,
    promptBytes: Buffer.byteLength(promptText, "utf8"),
    promptTokens: Math.ceil(promptText.length / 4),
    top: [...tools].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_N),
    longestDescriptions: [...tools].sort((a, b) => b.descBytes - a.descBytes).slice(0, Math.min(5, TOP_N)),
  };
}

// 聊天通路:技能走 use_skill + 系统提示词里的 <available_skills> 列表。
const chatSkillsBlock = skills.length === 0
  ? ""
  : `**Skills**\nYou have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.\n<available_skills>\n${skills
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n")}\n</available_skills>`;

// pi 通路:技能由 pi 资源层展开(带 location),工具摘要在系统提示词,通用/MCP 无摘要。
const piSkillBlock = skills.length === 0
  ? ""
  : [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${process.cwd()}/skills/${skill.name}/SKILL.md</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");

const piPromptExtras = [
  ...Object.entries(PROMPT_SNIPPETS).map(([name, snippet]) => `${name}: ${snippet}`),
  ...Object.values(PROMPT_GUIDELINES).flat(),
].join("\n") + piSkillBlock;

const chatSurface = buildSurface(
  "chat",
  [...searchDecls, ...localDecls, ...skillDecls, ...mcpDecls, ...subagentDecls, ...wsWithBash.map((decl) => ({ ...decl, source: "workspace" as Source }))],
  chatSkillsBlock,
);
const piSurface = buildSurface(
  "pi",
  [
    ...searchDecls,
    ...localDecls.filter((decl) => decl.name === "save_memory" || decl.name === "ask_user"),
    ...mcpDecls,
    ...wsWithBash.map((decl) => ({ ...decl, source: "workspace" as Source })),
  ],
  piPromptExtras,
);

// fallback 挂载(bash 不可用)只在聊天面常见;单列来源行,不并入主面。
const fallbackSurface = buildSurface(
  "workspace-fallback",
  wsFallback.map((decl) => ({ ...decl, source: "workspace" as Source })),
  "",
);

// ----- S9/S10 发现行账单(首轮 0 个 MCP 已激活 = 最坏情况) -----
// 与线上同一份纯函数:applyToolDiscovery 决定 tools 数组,buildToolCatalogContext
// 决定系统提示词目录段。发现关闭时的账单就是上面的 chat / pi 主面,可直接对照。

function asFunctionTools(decls: readonly ToolDecl[]): FunctionToolDeclaration[] {
  return decls.map((decl) => ({
    type: "function",
    function: { name: decl.name, description: decl.description, parameters: decl.parameters },
  }));
}

function sourcedFromDiscovery(
  decls: readonly FunctionToolDeclaration[],
  sourceOf: ReadonlyMap<string, Source>,
): SourcedDecl[] {
  return decls.map((decl) => ({
    name: decl.function.name,
    description: String(decl.function.description ?? ""),
    parameters: decl.function.parameters ?? { type: "object", properties: {} },
    source: sourceOf.get(decl.function.name) ?? "discovery",
  }));
}

const chatSourceByName = new Map(chatSurface.tools.map((tool) => [tool.name, tool.source]));
const piSourceByName = new Map(piSurface.tools.map((tool) => [tool.name, tool.source]));
const chatRawTools = asFunctionTools(chatSurface.tools);
const piRawTools = asFunctionTools(piSurface.tools);
const zeroActive = new Set<string>();
const chatDiscoverySurface = buildSurface(
  "chat-discovery",
  sourcedFromDiscovery(applyToolDiscovery(chatRawTools, zeroActive), chatSourceByName),
  [chatSkillsBlock, buildToolCatalogContext(discoverableToolPool(chatRawTools), zeroActive)].filter(Boolean).join("\n\n"),
);
const piDiscoverySurface = buildSurface(
  "pi-discovery",
  sourcedFromDiscovery(applyToolDiscovery(piRawTools, zeroActive), piSourceByName),
  [piPromptExtras, buildToolCatalogContext(discoverableToolPool(piRawTools), zeroActive)].filter(Boolean).join("\n\n"),
);

function discoveryBill(before: SurfaceReport, after: SurfaceReport) {
  return {
    activeMcpTools: 0,
    beforeTools: before.tools.length,
    afterTools: after.tools.length,
    beforeBytes: before.totalBytes,
    afterBytes: after.totalBytes,
    savedBytes: before.totalBytes - after.totalBytes,
    beforeTokens: before.totalTokens,
    afterTokens: after.totalTokens,
    catalogBytes: after.promptBytes - before.promptBytes,
    catalogTokens: after.promptTokens - before.promptTokens,
    // 真正进上下文的总量 = tools 声明 + 系统提示词增量;目录段是发现行的成本,必须一起算。
    beforeContextBytes: before.totalBytes + before.promptBytes,
    afterContextBytes: after.totalBytes + after.promptBytes,
    savedContextBytes: before.totalBytes + before.promptBytes - after.totalBytes - after.promptBytes,
  };
}

const discovery = {
  chat: discoveryBill(chatSurface, chatDiscoverySurface),
  pi: discoveryBill(piSurface, piDiscoverySurface),
};

// MCP schema 内联膨胀(S8):同一份共享 $defs schema,内联前/后的单工具体积。
const rawSchemaBytes = Buffer.byteLength(JSON.stringify(makeMcpSchema()), "utf8");
const inlinedSchemaBytes = Buffer.byteLength(JSON.stringify(inlineMcpToolSchema(makeMcpSchema() as never)), "utf8");
const mcpInline = {
  tools: MCP_TOOL_COUNT,
  rawSchemaBytes,
  inlinedSchemaBytes,
  rawTotalBytes: rawSchemaBytes * MCP_TOOL_COUNT,
  inlinedTotalBytes: inlinedSchemaBytes * MCP_TOOL_COUNT,
  deltaBytes: (inlinedSchemaBytes - rawSchemaBytes) * MCP_TOOL_COUNT,
};

// MCP description 治理(S8):同一 fixture 下裁剪前/后的 description 体积。
// enabled 只表示本次账单的 chat/pi 面是否用了裁剪;对比块恒输出,便于开关前后对照。
const rawMcpDescriptions = mcpServers.flatMap((server) => {
  const tools = (server.commonOptions as Record<string, JsonValue>).tools as Array<Record<string, JsonValue>>;
  return tools.map((tool) => ({ name: String(tool.name ?? ""), description: String(tool.description ?? "") }));
});
const cappedDescriptions = rawMcpDescriptions.map((item) => ({ name: item.name, ...capMcpToolDescription(item.description) }));
const descriptionBeforeBytes = rawMcpDescriptions.reduce((sum, item) => sum + Buffer.byteLength(item.description, "utf8"), 0);
const descriptionAfterBytes = cappedDescriptions.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
const truncatedDescriptions = cappedDescriptions.filter((item) => item.truncated);
const mcpDescription = {
  enabled: CAP_DESCRIPTIONS,
  maxChars: MCP_DESCRIPTION_MAX_CHARS,
  tools: rawMcpDescriptions.length,
  truncatedTools: truncatedDescriptions.length,
  beforeBytes: descriptionBeforeBytes,
  afterBytes: descriptionAfterBytes,
  savedBytes: descriptionBeforeBytes - descriptionAfterBytes,
  samples: truncatedDescriptions.slice(0, 3).map((item) => ({
    name: item.name,
    fromChars: item.originalChars,
    toChars: item.finalChars,
  })),
};

const fallbackWorkspace = {
  label: fallbackSurface.label,
  tools: fallbackSurface.tools.length,
  bytes: fallbackSurface.totalBytes,
  tokens: fallbackSurface.totalTokens,
};

// ----- 输出 -----

interface Report {
  fixture: { mcpTools: number; mcpServers: number; skills: number; mcpDescriptionChars: number };
  chat: Omit<SurfaceReport, "tools">;
  pi: Omit<SurfaceReport, "tools">;
  chatDiscovery: Omit<SurfaceReport, "tools">;
  piDiscovery: Omit<SurfaceReport, "tools">;
  discovery: typeof discovery;
  workspaceFallback: typeof fallbackWorkspace;
  mcpInline: typeof mcpInline;
  mcpDescription: typeof mcpDescription;
}

function stripTools(surface: SurfaceReport): Omit<SurfaceReport, "tools"> {
  const { tools: _tools, ...rest } = surface;
  return rest;
}

const report: Report = {
  fixture: { mcpTools: MCP_TOOL_COUNT, mcpServers: MCP_SERVER_COUNT, skills: SKILL_COUNT, mcpDescriptionChars: MCP_DESC_CHARS },
  chat: stripTools(chatSurface),
  pi: stripTools(piSurface),
  chatDiscovery: stripTools(chatDiscoverySurface),
  piDiscovery: stripTools(piDiscoverySurface),
  discovery,
  workspaceFallback: fallbackWorkspace,
  mcpInline,
  mcpDescription,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;
  console.log(`tool-surface — fixture: ${MCP_TOOL_COUNT} MCP tools / ${MCP_SERVER_COUNT} servers, ${SKILL_COUNT} skills`);
  console.log("token 估算 = chars/4(英文近似,仅用于相对比较)\n");

  for (const surface of [chatSurface, piSurface]) {
    console.log(`[${surface.label}] tools=${surface.tools.length} declaration=${kb(surface.totalBytes)} ~${surface.totalTokens} tok`
      + (surface.promptBytes > 0 ? ` | prompt-extras=${kb(surface.promptBytes)} ~${surface.promptTokens} tok` : ""));
    for (const [source, bucket] of Object.entries(surface.bySource).sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(`  ${source.padEnd(10)} x${String(bucket.count).padEnd(3)} ${kb(bucket.bytes).padStart(8)}  ~${bucket.tokens} tok`);
    }
    console.log("  top by size:");
    for (const tool of surface.top) {
      console.log(`    ${tool.name.padEnd(28)} ${kb(tool.bytes).padStart(8)}  ~${String(tool.tokens).padStart(5)} tok  desc=${kb(tool.descBytes)}`);
    }
    console.log("  longest descriptions:");
    for (const tool of surface.longestDescriptions) {
      console.log(`    ${tool.name.padEnd(28)} desc=${kb(tool.descBytes)}`);
    }
    console.log("");
  }

  console.log(`[workspace-fallback] tools=${fallbackWorkspace.tools} ${kb(fallbackWorkspace.bytes)} ~${fallbackWorkspace.tokens} tok`);
  console.log(`[discovery] active MCP tools=0/${MCP_TOOL_COUNT} (首轮最坏情况;发现关闭 = 上面的 chat/pi 主面)`);
  for (const [label, bill] of [["chat", discovery.chat], ["pi", discovery.pi]] as const) {
    console.log(`  ${label.padEnd(5)} tools ${bill.beforeTools} -> ${bill.afterTools}`
      + ` | declaration ${kb(bill.beforeBytes)} -> ${kb(bill.afterBytes)} (saved ${kb(bill.savedBytes)})`
      + ` | catalog +${kb(bill.catalogBytes)}`
      + ` | context ${kb(bill.beforeContextBytes)} -> ${kb(bill.afterContextBytes)} (saved ${kb(bill.savedContextBytes)})`);
  }
  console.log(`[mcp-inline] raw/schema=${kb(mcpInline.rawSchemaBytes)} inlined/schema=${kb(mcpInline.inlinedSchemaBytes)}`
    + ` delta=${kb(mcpInline.deltaBytes)} over ${mcpInline.tools} tools`);
  console.log(`[mcp-description] cap=${mcpDescription.enabled ? "on" : "off"} maxChars=${mcpDescription.maxChars}`
    + ` truncated=${mcpDescription.truncatedTools}/${mcpDescription.tools}`
    + ` desc=${kb(mcpDescription.beforeBytes)} -> ${kb(mcpDescription.afterBytes)} (saved ${kb(mcpDescription.savedBytes)})`);
  for (const sample of mcpDescription.samples) {
    console.log(`    ${sample.name.padEnd(28)} ${sample.fromChars} -> ${sample.toChars} chars`);
  }
}
