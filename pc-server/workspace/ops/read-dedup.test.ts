// workspace/ops/read-dedup.test.ts — S4 重复读取去重回归
// 覆盖:首读全文带 ref、同参数重读短路、证据缺失/压缩后回全文、revision 变化回全文、
// 工作区签名变化失效、窗口续读位保留、32 条上限淘汰、短结果不自证。

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReadTool } from "../tools/read";
import type { ToolTextContent } from "../tools/types";
import { decorateReadOutput, type ReadDedupContext } from "./read-contract";
import { readDedupSize, resetReadDedupForTests } from "./read-dedup";
import { sha256Short } from "./revision";

const dir = mkdtempSync(join(tmpdir(), "rkh-read-dedup-"));

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((entry) => entry.type === "text") as ToolTextContent[])
    .map((entry) => entry.text)
    .join("\n");
}

/** 模拟「即将发送的消息列表」:只收工具结果原文;压缩 = 清空。 */
function evidenceBox(): { visible: string[]; probe: (marker: string) => boolean } {
  const visible: string[] = [];
  return { visible, probe: (marker) => visible.some((text) => text.includes(marker)) };
}

async function readWithDedup(
  fileName: string,
  dedup: ReadDedupContext | undefined,
  args: { offset?: number; limit?: number } = {},
): Promise<{ text: string; details: unknown }> {
  const tool = createReadTool(dir);
  const raw = await tool.execute({ path: fileName, ...args });
  const decorated = await decorateReadOutput(
    { pathArg: fileName, cwd: dir, ...args, ...(dedup ? { dedup } : {}) },
    raw,
    { contractEnabled: true, dedupEnabled: true },
  );
  return { text: textOf(decorated), details: decorated.details };
}

/** 24 行 × ~50 字节:足以让一行引用确实比全文更省(小文件由装饰层自动弃用短路)。 */
function makeContent(lines = 24): string {
  return Array.from({ length: lines }, (_, i) => `row-${i + 1}: ${"payload-".repeat(5)}end`).join("\n");
}

function refOf(text: string): string {
  const match = text.match(/\[ref=(r[0-9a-f]{8})\]$/m);
  if (!match) throw new Error(`no ref marker in: ${text}`);
  return match[1]!;
}

describe("S4 重复读取去重", () => {
  beforeEach(() => resetReadDedupForTests());

  test("首读全文带 ref,同参数重读短路为一行引用", async () => {
    const name = "dedup-basic.txt";
    const content = makeContent();
    writeFileSync(join(dir, name), content);
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-basic", workspaceSignature: "ws", probe: evidence.probe });

    const first = await readWithDedup(name, ctx());
    expect(first.text).toContain("1|row-1");
    expect(first.text).toContain(`[revision=${sha256Short(Buffer.from(content))}; 24 lines; end of file]`);
    const ref = refOf(first.text);
    evidence.visible.push(first.text);

    const second = await readWithDedup(name, ctx());
    expect(second.text.startsWith("[unchanged: ")).toBe(true);
    expect(second.text).toContain(`${name} lines 1-24`);
    expect(second.text).toContain(`revision=${sha256Short(Buffer.from(content))}`);
    expect(second.text).toContain("24 lines; end of file");
    expect(second.text).toContain(`ref #${ref}`);
    // 短结果不得自带 [ref=...] 标记,否则会被下一次探针当作原文证据。
    expect(second.text).not.toContain(`[ref=${ref}]`);
    expect(second.text.length).toBeLessThan(first.text.length);
  });

  test("证据不足(无探针)时重复读取仍回全文", async () => {
    const name = "dedup-noprobe.txt";
    writeFileSync(join(dir, name), makeContent());
    const ctx = (): ReadDedupContext => ({ conversationId: "c-noprobe", workspaceSignature: "ws" });
    await readWithDedup(name, ctx());
    const second = await readWithDedup(name, ctx());
    expect(second.text).toContain("1|row-1");
    expect(second.text).not.toContain("[unchanged:");
    // 登记仍然发生:后续挂上证据的读取(同一全文仍在会话里)可以命中。
    const evidence = evidenceBox();
    evidence.visible.push(second.text);
    const third = await readWithDedup(name, { conversationId: "c-noprobe", workspaceSignature: "ws", probe: evidence.probe });
    expect(third.text.startsWith("[unchanged: ")).toBe(true);
  });

  test("压缩后(原全文不再可见)回全文", async () => {
    const name = "dedup-compacted.txt";
    writeFileSync(join(dir, name), makeContent());
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-compact", workspaceSignature: "ws", probe: evidence.probe });
    const first = await readWithDedup(name, ctx());
    evidence.visible.push(first.text);
    const second = await readWithDedup(name, ctx());
    expect(second.text.startsWith("[unchanged: ")).toBe(true);

    // 压缩:active 消息重建成摘要视图,原全文与短结果一并消失。
    evidence.visible.length = 0;
    const afterCompaction = await readWithDedup(name, ctx());
    expect(afterCompaction.text).toContain("1|row-1");
    expect(afterCompaction.text).not.toContain("[unchanged:");
  });

  test("文件 revision 变化:即便旧标记仍可见也回全文并换新 ref", async () => {
    const name = "dedup-changed.txt";
    writeFileSync(join(dir, name), makeContent());
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-changed", workspaceSignature: "ws", probe: evidence.probe });
    const first = await readWithDedup(name, ctx());
    evidence.visible.push(first.text);
    const oldRef = refOf(first.text);

    writeFileSync(join(dir, name), makeContent().replaceAll("row-", "line-"));
    const second = await readWithDedup(name, ctx());
    expect(second.text).toContain("1|line-1");
    expect(second.text).not.toContain("[unchanged:");
    const newRef = refOf(second.text);
    expect(newRef).not.toBe(oldRef);
    evidence.visible.push(second.text);

    const third = await readWithDedup(name, ctx());
    expect(third.text.startsWith("[unchanged: ")).toBe(true);
    expect(third.text).toContain(`ref #${newRef}`);
  });

  test("工作区/权限签名变化:旧指纹失效", async () => {
    const name = "dedup-signature.txt";
    writeFileSync(join(dir, name), makeContent());
    const evidence = evidenceBox();
    const first = await readWithDedup(name, { conversationId: "c-sig", workspaceSignature: "ws-a", probe: evidence.probe });
    evidence.visible.push(first.text);
    const otherWorkspace = await readWithDedup(name, { conversationId: "c-sig", workspaceSignature: "ws-b", probe: evidence.probe });
    expect(otherWorkspace.text).toContain("1|row-1");
    expect(otherWorkspace.text).not.toContain("[unchanged:");
  });

  test("小文件不短路:一行引用比正文更长时照常回全文", async () => {
    const name = "dedup-small.txt";
    writeFileSync(join(dir, name), "alpha\nbeta");
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-small", workspaceSignature: "ws", probe: evidence.probe });
    const first = await readWithDedup(name, ctx());
    evidence.visible.push(first.text);
    const second = await readWithDedup(name, ctx());
    expect(second.text).toContain("1|alpha");
    expect(second.text).not.toContain("[unchanged:");
  });

  test("窗口读取:短路保留行范围与 nextOffset", async () => {
    const name = "dedup-window.txt";
    writeFileSync(join(dir, name), Array.from({ length: 300 }, (_, i) => `line-${i + 1}`).join("\n"));
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-window", workspaceSignature: "ws", probe: evidence.probe });
    const args = { offset: 101, limit: 50 };
    const first = await readWithDedup(name, ctx(), args);
    evidence.visible.push(first.text);
    const second = await readWithDedup(name, ctx(), args);
    expect(second.text.startsWith("[unchanged: ")).toBe(true);
    expect(second.text).toContain("lines 101-150");
    expect(second.text).toContain("more lines; nextOffset=151");
    // 不同 limit 是不同指纹:不受同文件其他窗口影响。
    const otherWindow = await readWithDedup(name, ctx(), { offset: 101, limit: 10 });
    expect(otherWindow.text).toContain("101|line-101");
    expect(otherWindow.text).not.toContain("[unchanged:");
  });

  test("每会话 32 条上限:最旧指纹被淘汰后回全文", async () => {
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-cap", workspaceSignature: "ws", probe: evidence.probe });
    for (let i = 0; i < 33; i += 1) {
      const name = `dedup-cap-${i}.txt`;
      writeFileSync(join(dir, name), makeContent());
      const read = await readWithDedup(name, ctx());
      evidence.visible.push(read.text);
    }
    expect(readDedupSize("c-cap")).toBe(32);

    // 0 号已被淘汰:即便旧标记仍在场也回全文;再次登记后第三次才短路。
    const again = await readWithDedup("dedup-cap-0.txt", ctx());
    expect(again.text).toContain("1|row-1");
    expect(again.text).not.toContain("[unchanged:");
    evidence.visible.push(again.text);
    const third = await readWithDedup("dedup-cap-0.txt", ctx());
    expect(third.text.startsWith("[unchanged: ")).toBe(true);
  });

  test("内核截断的读取:短路后 details.truncation 原值保留", async () => {
    const name = "dedup-truncated.txt";
    writeFileSync(join(dir, name), Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n"));
    const evidence = evidenceBox();
    const ctx = (): ReadDedupContext => ({ conversationId: "c-trunc", workspaceSignature: "ws", probe: evidence.probe });
    const first = await readWithDedup(name, ctx());
    evidence.visible.push(first.text);
    const second = await readWithDedup(name, ctx());
    expect(second.text.startsWith("[unchanged: ")).toBe(true);
    expect(second.text).toContain("more lines; nextOffset=2001");
    const truncation = (second.details as { truncation?: { truncated: boolean } } | undefined)?.truncation;
    expect(truncation?.truncated).toBe(true);
  });
});
