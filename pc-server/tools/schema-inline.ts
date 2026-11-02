// tools/schema-inline.ts — MCP 工具 inputSchema 的 $ref 内联展开(单一净化层)
//
// 为什么:开源 MCP 工具的 schema 越来越常用 $defs/$ref 复用子结构。我们的出线路里
// OpenAI/Claude 对完整 schema($defs+$ref 原样)是兼容的,但 Google 原生路
// (functionDeclarations.parameters 是 OpenAPI 子集)不认 $ref——悬空引用即 400,
// 拒掉整条请求(安卓 #1974 实证)。在工具声明单源处(openAiMcpTools)展开,聊天引擎
// 三家协议与 pi 引擎(general-tools/workspace-tools 复用同一声明)天然继承,未来
// 新引擎亦然——这是比安卓(转换层各自展开)更靠上游的单点。
//
// 展开规则(镜像安卓 McpToolSchema.kt cf79246b,行为逐条对齐):
//   - 只沿承载子 Schema 的关键字遍历;enum/const/default/examples 等字面量数据
//     即使含 "$ref" 字段也原样保留(它们不是 schema)。
//   - 与 $ref 同级的关键字(description/default 等)覆盖被引用定义的同名键。
//   - 循环引用在回到自身处截断,只保留被引用定义的 type。
//   - 无法解析的引用(外部 URL/指针不存在)去掉 $ref,退化为不限制类型——发悬空
//     引用必 400,发宽松 schema 只是模型少一层约束。
//   - 展开后 $defs 整体丢弃(已无人引用)。
//
// S8 治理:加引用展开 memo。同一 $ref 在不同位置被引用时只递归展开一次,各处共享
// 同一份(只读)子树,避免共享 $defs 被 N 处引用时的 N 倍重复计算。memo 只缓存
// "与调用路径无关"的展开:引用闭包(目标子树里可达的全部引用)与当前解析链相交,
// 或子图本身有环时,展开会在环处截断、随路径变化,这类结果不跨路径复用——语义与
// 无 memo 版本逐字一致。根上的 $defs/$definitions 最终整体丢弃,不再白展开一遍。

import type { JsonValue } from "../foundation/types";

/** 值为子 Schema(或其数组)的关键字——递归展开沿这些键下行。 */
const SCHEMA_KEYWORDS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** 值为「名称 -> 子 Schema」映射的关键字。 */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/** 工具 inputSchema 里没有任何文档内引用时返回 true,调用方可跳过克隆(零开销快路径)。 */
function hasLocalRef(node: JsonValue): boolean {
  if (Array.isArray(node)) return node.some(hasLocalRef);
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#")) return true;
      if (value !== undefined && hasLocalRef(value)) return true;
    }
  }
  return false;
}

/** 解析文档内 JSON Pointer 引用(如 #/$defs/Foo);找不到或非文档内引用返回 null。 */
function resolvePointer(root: JsonValue, ref: string): JsonValue | null {
  if (!ref.startsWith("#")) return null;
  const tokens = ref.slice(1).split("/").filter(Boolean)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: JsonValue | undefined = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      current = current[Number.parseInt(token, 10) as never];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, JsonValue>)[token];
    } else {
      return null;
    }
    if (current === undefined) return null;
  }
  return current ?? null;
}

/** 一次展开的上下文:memo 活在一次 inlineMcpToolSchema 调用内。 */
interface InlineContext {
  root: JsonValue;
  /** ref -> 与调用路径无关的展开结果(子树跨 occurrence 共享,调用方只读)。 */
  expanded: Map<string, JsonValue>;
  /** ref -> 引用闭包;只缓存无环闭包(有环时展开与路径有关,闭包也要按路径重算)。 */
  closures: Map<string, RefClosure>;
  /** 正在计算闭包的引用链,用于发现环。 */
  pending: Set<string>;
}

/** 被引用定义可达的引用集合(含自身)。cyclic = 子图含环。 */
interface RefClosure {
  refs: Set<string>;
  cyclic: boolean;
}

/** 收集节点里全部文档内 $ref。字面量数据里的也收——只让缓存更保守,不影响输出。 */
function collectRefs(node: JsonValue, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#")) {
      out.add(value);
    } else if (value !== undefined) {
      collectRefs(value, out);
    }
  }
}

function closureOf(ctx: InlineContext, ref: string): RefClosure {
  const cached = ctx.closures.get(ref);
  if (cached) return cached;
  // 闭包计算回到正在计算的引用:该子图有环。
  if (ctx.pending.has(ref)) return { refs: new Set([ref]), cyclic: true };
  ctx.pending.add(ref);
  const info: RefClosure = { refs: new Set([ref]), cyclic: false };
  const target = resolvePointer(ctx.root, ref);
  if (target !== null) {
    const direct = new Set<string>();
    collectRefs(target, direct);
    for (const dep of direct) {
      if (dep === ref) {
        info.cyclic = true;
        continue;
      }
      const sub = closureOf(ctx, dep);
      for (const depRef of sub.refs) info.refs.add(depRef);
      if (sub.cyclic) info.cyclic = true;
    }
  }
  ctx.pending.delete(ref);
  // 有环闭包不缓存:环检测结果依赖从哪条路径进来,缓存会在别处误判无环。
  if (!info.cyclic) ctx.closures.set(ref, info);
  return info;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) return true;
  }
  return false;
}

function inlineSchema(schema: JsonValue, ctx: InlineContext, resolving: ReadonlySet<string>): JsonValue {
  if (Array.isArray(schema)) return schema.map((item) => inlineSchema(item, ctx, resolving));
  if (schema === null || typeof schema !== "object") return schema;
  const record = schema as Record<string, JsonValue>;
  const ref = typeof record.$ref === "string" ? record.$ref : null;
  // 先递归子结构(剥掉 $ref 键本身),同级关键字先就位——它们之后要覆盖被引用定义。
  const inlined: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "$ref") continue;
    // 根上的定义容器在出口处整体丢弃(见 inlineMcpToolSchema),这里不必展开;
    // 引用解析读的是原 root,与是否预展开无关。
    if (schema === ctx.root && (key === "$defs" || key === "definitions")) continue;
    if (SCHEMA_KEYWORDS.has(key)) {
      inlined[key] = Array.isArray(value)
        ? value.map((item) => inlineSchema(item, ctx, resolving))
        : inlineSchema(value, ctx, resolving);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      inlined[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonValue>).map(([name, sub]) => [name, inlineSchema(sub, ctx, resolving)]),
      );
    } else {
      inlined[key] = value;
    }
  }
  if (ref === null) return inlined;
  // 闭包与解析链相交 / 子图有环 -> 展开随路径变化(环处截断),不跨路径复用。
  const closure = closureOf(ctx, ref);
  const reusable = !closure.cyclic && !intersects(closure.refs, resolving);
  let expanded = reusable ? (ctx.expanded.get(ref) as Record<string, JsonValue> | undefined) : undefined;
  if (expanded === undefined) {
    const target = resolvePointer(ctx.root, ref);
    if (target === null || target === undefined) {
      // 无法解析:去掉 $ref,退化为不限制类型(发悬空引用必 400,宽松 schema 只是少一层约束)。
      expanded = {};
    } else if (resolving.has(ref)) {
      // 循环引用:回到自身处截断,只保留被引用定义的 type。
      const targetType = target !== null && typeof target === "object" && !Array.isArray(target)
        ? (target as Record<string, JsonValue>).type
        : undefined;
      expanded = typeof targetType === "string" ? { type: targetType } : {};
    } else {
      const expandedNode = inlineSchema(target, ctx, new Set(resolving).add(ref));
      expanded = expandedNode !== null && typeof expandedNode === "object" && !Array.isArray(expandedNode)
        ? (expandedNode as Record<string, JsonValue>)
        : {};
    }
    if (reusable) ctx.expanded.set(ref, expanded);
  }
  // 与 $ref 同级的关键字覆盖被引用定义(展开值在前,本地键在后)。
  return { ...expanded, ...inlined };
}

/** MCP 工具 inputSchema 出线净化:内联展开所有文档内 $ref,丢弃 $defs。
 *  无 $ref 的 schema 原对象返回(调用方零拷贝成本,数量占绝大多数)。 */
export function inlineMcpToolSchema(schema: JsonValue): JsonValue {
  if (!hasLocalRef(schema)) return schema;
  const ctx: InlineContext = {
    root: schema,
    expanded: new Map(),
    closures: new Map(),
    pending: new Set(),
  };
  const inlined = inlineSchema(schema, ctx, new Set());
  // $defs/$definitions 是纯引用容器,展开后已无人引用——留在根上只会白占 token
  // (Google 路还会因未知关键字增加 400 面),丢弃。
  if (inlined !== null && typeof inlined === "object" && !Array.isArray(inlined)) {
    const { $defs: _defs, definitions: _definitions, ...rest } = inlined as Record<string, JsonValue>;
    return rest;
  }
  return inlined;
}
