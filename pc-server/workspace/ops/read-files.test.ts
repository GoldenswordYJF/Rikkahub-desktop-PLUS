// workspace/ops/read-files.test.ts — S7 批量读取回归
// 覆盖:1-32 上限、逐项 offset/limit、逐项错误不牵连他项、S2 行号/revision/续读位复用、
// 两层完成状态(逐文件 complete/nextOffset + 整体 pending)、响应预算与落空清单。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReadFilesTool, parseReadCompletion, READ_FILES_RESPONSE_BUDGET_BYTES } from "./read-files";
import type { ToolTextContent } from "../tools/types";

function textOf(content: Array<{ type: string }>): string {
  return content.filter((c) => c.type === "text").map((c) => (c as ToolTextContent).text).join("\n");
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "rkh-read-files-"));
}

describe("S7 read_files:批量读取", () => {
  test("5 个文件 1 个不存在:其余 4 个正常,各自带 revision 与完成状态", async () => {
    const root = makeRoot();
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(root, name), `content of ${name}\n`);
    const tool = createReadFilesTool(root, { readContract: true });
    const result = await tool.execute({
      files: [
        { path: "a.txt" },
        { path: "missing.txt" },
        { path: "b.txt" },
        { path: "c.txt" },
        { path: "d.txt" },
      ],
    });
    const text = textOf(result.content);
    expect(text).toContain("### a.txt");
    expect(text).toContain("1|content of a.txt");
    expect(text).toContain("### missing.txt\nError: ");
    expect(text).toContain("### d.txt");
    expect(text.match(/\[revision=[0-9a-f]+; 2 lines; end of file\]/g)).toHaveLength(4);
    expect(result.details?.files.map((file) => file.status)).toEqual([
      "complete",
      "error",
      "complete",
      "complete",
      "complete",
    ]);
    expect(result.details?.pending).toBeUndefined();
  });

  test("逐项独立 offset/limit:窗口与 nextOffset 各自独立", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "big.txt"), Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
    writeFileSync(join(root, "small.txt"), "only line\n");
    const tool = createReadFilesTool(root, { readContract: true });
    const result = await tool.execute({
      files: [
        { path: "big.txt", offset: 11, limit: 5 },
        { path: "small.txt" },
      ],
    });
    const text = textOf(result.content);
    expect(text).toContain("### big.txt (offset=11, limit=5)");
    expect(text).toContain("11|line-11");
    expect(text).toContain("15|line-15");
    expect(text).toContain("[revision=");
    expect(text).toContain("more lines; nextOffset=16]");
    expect(text).toContain("### small.txt");
    expect(result.details?.files[0]).toMatchObject({ status: "more", nextOffset: 16 });
    expect(result.details?.files[1]?.status).toBe("complete");
  });

  test("总数超 32 / 空数组:整单拒绝", async () => {
    const root = makeRoot();
    const tool = createReadFilesTool(root, { readContract: true });
    await expect(tool.execute({ files: [] })).rejects.toThrow("requires 1-32 files");
    await expect(
      tool.execute({ files: Array.from({ length: 33 }, (_, i) => ({ path: `f${i}.txt` })) }),
    ).rejects.toThrow("at most 32 files");
  });

  test("契约关闭:逐项保持内核原文,仍可凭内核提示续读", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
    const tool = createReadFilesTool(root);
    const result = await tool.execute({ files: [{ path: "big.txt" }] });
    const text = textOf(result.content);
    expect(text).toContain("Use offset=2001 to continue.");
    expect(text).not.toContain("[revision=");
    expect(result.details?.files[0]).toMatchObject({ status: "more", nextOffset: 2001 });
  });

  test("响应预算耗尽:整体 pending 列出未读文件,已读项不受影响", async () => {
    const root = makeRoot();
    const line = "x".repeat(60);
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(root, `large-${index}.txt`), Array.from({ length: 2000 }, () => line).join("\n"));
    }
    const tool = createReadFilesTool(root, { readContract: true });
    const result = await tool.execute({
      files: Array.from({ length: 5 }, (_, index) => ({ path: `large-${index}.txt` })),
    });
    const text = textOf(result.content);
    const skipped = result.details?.files.filter((file) => file.status === "skipped") ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    expect(result.details?.pending).toBe(skipped.length);
    expect(text).toContain("response budget of");
    expect(text).toContain("Not read: ");
    expect(text).toContain("call read_files again for these files");
    // 实际正文(不含最后一行 pending 说明)不超过预算。
    const bodyBytes = Buffer.byteLength(text, "utf-8");
    expect(bodyBytes).toBeLessThan(READ_FILES_RESPONSE_BUDGET_BYTES + 4096);
  });
});

describe("S7 完成状态解析", () => {
  test("契约尾行:end of file / nextOffset", () => {
    expect(parseReadCompletion("1|a\n[revision=abc123; 1 line; end of file]")).toEqual({
      status: "complete",
      revision: "abc123",
    });
    expect(parseReadCompletion("1|a\n[revision=def456; 9 lines; more lines; nextOffset=2]")).toEqual({
      status: "more",
      revision: "def456",
      nextOffset: 2,
    });
  });

  test("内核提示与纯文本", () => {
    expect(parseReadCompletion("abc\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]")).toEqual({
      status: "more",
      nextOffset: 2001,
    });
    expect(parseReadCompletion("abc\n\n[3 more lines in file. Use offset=9 to continue.]")).toEqual({
      status: "more",
      nextOffset: 9,
    });
    expect(parseReadCompletion("plain text")).toEqual({ status: "complete" });
  });
});
