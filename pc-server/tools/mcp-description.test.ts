// tools/mcp-description 单测(S8):超长 MCP description 截断 + 关键说明保留 + 上限恒成立;
// 另验证声明单源 openAiMcpTools 只在开关打开时应用裁剪(关闭时逐字透传)。
import { describe, expect, test } from "bun:test";

import type { Assistant } from "../foundation/types";
import { openAiMcpTools } from "./definitions";
import { capMcpToolDescription, MCP_DESCRIPTION_MAX_CHARS } from "./mcp-description";

const filler = (chars: number) =>
  "This paragraph is ordinary usage prose that only explains background and examples. ".repeat(
    Math.ceil(chars / 84),
  ).slice(0, chars);

describe("capMcpToolDescription — MCP description 长度治理", () => {
  test("未超限:原样返回(同一字符串,不引入空白/换行变化)", () => {
    const raw = "Short description.\nSecond line.";
    const result = capMcpToolDescription(raw, 100);
    expect(result.text).toBe(raw);
    expect(result.truncated).toBe(false);
    expect(result.originalChars).toBe(raw.length);
    expect(result.finalChars).toBe(raw.length);
  });

  test("超限:输出不超过上限,保留开头摘要并带截断标记", () => {
    const raw = `Search records. ${filler(4000)}`;
    const result = capMcpToolDescription(raw, 600);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(600);
    expect(result.text.startsWith("Search records.")).toBe(true);
    expect(result.text.endsWith("[…description truncated]")).toBe(true);
    expect(result.finalChars).toBe(result.text.length);
    expect(result.originalChars).toBe(raw.length);
  });

  test("正文里的 IMPORTANT/NOTE 关键说明被保留(即使位于被截掉的后半段)", () => {
    const raw = [
      "Manage browser tabs.",
      filler(3000),
      "IMPORTANT: Always pass the tab id returned by tabs_list; stale ids must be refreshed first.",
      filler(2000),
      "- **NOTE**: Only one download may run at a time.",
    ].join("\n\n");
    const result = capMcpToolDescription(raw, 700);
    expect(result.text.length).toBeLessThanOrEqual(700);
    expect(result.text).toContain("IMPORTANT:");
    expect(result.text).toContain("stale ids must be refreshed");
    expect(result.text).toContain("Only one download may run at a time");
  });

  test("强制语气句(Always/Never/Do not)也被视为关键说明;普通散文不挤占预算", () => {
    const raw = [
      "Execute a shell command.",
      filler(2000),
      "Never run destructive commands without explicit confirmation.",
      filler(800),
      "Do not use this tool for long-running servers.",
    ].join("\n\n");
    const result = capMcpToolDescription(raw, 500);
    expect(result.text).toContain("Never run destructive commands");
    expect(result.text).toContain("Do not use this tool for long-running servers");
    // 普通散文只应出现在开头摘要里,不能把关键说明挤出上限。
    expect(result.text.length).toBeLessThanOrEqual(500);
  });

  test("确定性:同一输入重复调用得到相同文本(无时间/随机因素)", () => {
    const raw = `Tool. ${filler(2500)}\n\nIMPORTANT: keep this.`;
    expect(capMcpToolDescription(raw, 400).text).toBe(capMcpToolDescription(raw, 400).text);
  });

  test("极小上限也不抛错且仍守住上限(边界退化)", () => {
    const raw = filler(500);
    for (const maxChars of [0, 10, 40, 80]) {
      const result = capMcpToolDescription(raw, maxChars);
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  test("默认上限常量与行为一致(1500 字符)", () => {
    expect(MCP_DESCRIPTION_MAX_CHARS).toBe(1500);
    const raw = filler(2000);
    expect(capMcpToolDescription(raw).text.length).toBeLessThanOrEqual(MCP_DESCRIPTION_MAX_CHARS);
  });
});

describe("openAiMcpTools — descriptionCap 开关", () => {
  const longDescription = `Records search. ${filler(4000)}`;
  const mcpServers = [{
    id: "srv-1",
    commonOptions: {
      name: "Records",
      enable: true,
      tools: [{ name: "records_search", description: longDescription, inputSchema: { type: "object" } }],
    },
  }];
  const assistant = { mcpServers: ["srv-1"], mcpToolOverrides: {} } as unknown as Assistant;

  test("开关关闭(缺省):description 逐字透传", () => {
    const tools = openAiMcpTools(assistant, mcpServers);
    expect(tools[0]!.function.name).toBe("mcp__records_search");
    expect(tools[0]!.function.description).toBe(longDescription);
  });

  test("开关打开:description 截断,参数 schema 不变", () => {
    const before = openAiMcpTools(assistant, mcpServers)[0]!;
    const after = openAiMcpTools(assistant, mcpServers, { descriptionCap: true })[0]!;
    expect(after.function.description.length).toBeLessThanOrEqual(MCP_DESCRIPTION_MAX_CHARS);
    expect(after.function.description).toContain("Records search.");
    expect(after.function.parameters).toEqual(before.function.parameters);
  });
});
