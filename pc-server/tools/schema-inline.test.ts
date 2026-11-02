// tools/schema-inline 单测:$ref 内联展开的六条行为锁,用例镜像安卓 McpToolSchemaTest
// (cf79246b,#1974)。动机:Google 原生路(functionDeclarations.parameters 是 OpenAPI
// 子集)不认 $ref——悬空引用拒整条请求;展开在 openAiMcpTools 声明单源处做,聊天
// 引擎三家协议与 pi 引擎同源继承。
import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../foundation/types";
import { inlineMcpToolSchema } from "./schema-inline";

const json = (text: string): JsonValue => JSON.parse(text);

describe("inlineMcpToolSchema — $ref 内联展开", () => {
  test("无 $ref 的 schema 原对象返回(零拷贝快路径)", () => {
    const schema = json(`{"type":"object","properties":{"query":{"type":"string","description":"keyword"}},"required":["query"]}`);
    expect(inlineMcpToolSchema(schema)).toBe(schema);
  });

  test("引用内联展开,同级关键字覆盖被引用定义;items/anyOf 等承载键递归下行", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "trigger": {"$ref": "#/$defs/Trigger", "description": "override"},
        "items": {"type": "array", "items": {"$ref": "#/$defs/Trigger"}},
        "choice": {"anyOf": [{"$ref": "#/$defs/Trigger"}, {"type": "null"}]}
      },
      "$defs": {
        "Trigger": {
          "type": "object",
          "description": "original",
          "properties": {"spec": {"$ref": "#/$defs/Spec"}}
        },
        "Spec": {"type": "string", "enum": ["a", "b"]}
      }
    }`)) as Record<string, any>;
    const trigger = { type: "object", description: "original", properties: { spec: { type: "string", enum: ["a", "b"] } } };
    expect(result.properties.trigger).toEqual({ ...trigger, description: "override" });
    expect(result.properties.items).toEqual({ type: "array", items: trigger });
    expect(result.properties.choice).toEqual({ anyOf: [trigger, { type: "null" }] });
    // $defs 展开后整体消失,产物不再含任何 $ref(悬空引用 400 的来源清零)。
    expect(JSON.stringify(result)).not.toContain("$ref");
    expect(result.$defs).toBeUndefined();
  });

  test("字面量数据(enum/const/default/examples)里的 $ref 字段原样保留,不当 schema 展开", () => {
    const properties = {
      trigger: {
        enum: [{ $ref: "document.json" }],
        const: { $ref: "#/$defs/Spec" },
        default: { $ref: "document.json" },
        examples: [{ $ref: "#/$defs/Spec" }],
      },
    };
    const result = inlineMcpToolSchema({ type: "object", properties, $defs: { Spec: { type: "string" } } }) as Record<string, any>;
    expect(result.properties.trigger).toEqual(properties.trigger);
  });

  test("名为关键字形状的属性(default/enum 作属性名)仍按子 Schema 处理", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "default": {"$ref": "#/$defs/Spec"},
        "trigger": {"type": "object", "properties": {"enum": {"$ref": "#/$defs/Spec"}}}
      },
      "$defs": {"Spec": {"type": "string"}}
    }`)) as Record<string, any>;
    expect(result.properties.default).toEqual({ type: "string" });
    expect(result.properties.trigger.properties.enum).toEqual({ type: "string" });
  });

  test("循环引用在回到自身处截断,只保留被引用定义的 type", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {"trigger": {"$ref": "#/$defs/Node"}},
      "$defs": {
        "Node": {
          "type": "object",
          "properties": {"children": {"type": "array", "items": {"$ref": "#/$defs/Node"}}}
        }
      }
    }`)) as Record<string, any>;
    expect(result.properties.trigger).toEqual({
      type: "object",
      properties: { children: { type: "array", items: { type: "object" } } },
    });
  });

  test("无法解析的引用(指针缺失/外部 URL)去掉 $ref,不发悬空引用", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "trigger": {"$ref": "#/$defs/Missing", "description": "kept"},
        "remote": {"$ref": "https://example.com/schema.json"}
      }
    }`)) as Record<string, any>;
    expect(result.properties.trigger).toEqual({ description: "kept" });
    expect(result.properties.remote).toEqual({});
    expect(JSON.stringify(result)).not.toContain("$ref");
  });

  // ----- S8:memo(同一子树只展开一次) -----

  test("memo:同一 $ref 跨 occurrence 只展开一次,共享同一份只读子树", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "left": {"$ref": "#/$defs/A"},
        "right": {"$ref": "#/$defs/A", "description": "right override"}
      },
      "$defs": {
        "A": {"type": "object", "properties": {"leaf": {"$ref": "#/$defs/B"}}},
        "B": {"type": "string", "enum": ["x", "y"]}
      }
    }`)) as Record<string, any>;
    // 同级覆盖仍然生效(description 只在 right 上)。
    expect(result.properties.left).toEqual({ type: "object", properties: { leaf: { type: "string", enum: ["x", "y"] } } });
    expect(result.properties.right.description).toBe("right override");
    // 共享证据:嵌套子树是同一个对象引用,不是两次独立展开。
    expect(result.properties.left.properties).toBe(result.properties.right.properties);
    expect(result.properties.left.properties.leaf).toBe(result.properties.right.properties.leaf);
  });

  test("memo:循环引用在多处引用时仍各自截断,不因缓存泄漏完整递归体", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "properties": {
        "a": {"$ref": "#/$defs/Node"},
        "b": {"$ref": "#/$defs/Node"}
      },
      "$defs": {
        "Node": {
          "type": "object",
          "properties": {"children": {"type": "array", "items": {"$ref": "#/$defs/Node"}}}
        }
      }
    }`)) as Record<string, any>;
    const expected = { type: "object", properties: { children: { type: "array", items: { type: "object" } } } };
    expect(result.properties.a).toEqual(expected);
    expect(result.properties.b).toEqual(expected);
  });

  test("memo:菱形引用(共享定义再互引)展开结果与无 memo 语义一致", () => {
    const result = inlineMcpToolSchema(json(`{
      "type": "object",
      "$defs": {
        "Base": {"type": "object", "properties": {"id": {"type": "integer"}}},
        "Left": {"type": "object", "properties": {"base": {"$ref": "#/$defs/Base"}}},
        "Right": {"type": "object", "properties": {"base": {"$ref": "#/$defs/Base"}}},
        "Both": {"type": "object", "properties": {
          "left": {"$ref": "#/$defs/Left"},
          "right": {"$ref": "#/$defs/Right"}
        }}
      },
      "properties": {"both": {"$ref": "#/$defs/Both"}}
    }`)) as Record<string, any>;
    const base = { type: "object", properties: { id: { type: "integer" } } };
    expect(result.properties.both).toEqual({
      type: "object",
      properties: {
        left: { type: "object", properties: { base } },
        right: { type: "object", properties: { base } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("$ref");
  });
});
