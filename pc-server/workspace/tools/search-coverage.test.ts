// workspace/tools/search-coverage.test.ts — S5 搜索覆盖可见化回归
// 覆盖:有缺口时匹配结果追加 [Coverage:]、零匹配不再断言不存在、缺口计数进 details、
// 范围外排除不算缺口(无缺口时保持历史逐字文案)、开关关闭行为逐字不变、上限提示带扫描数。

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGrepTool } from "./grep";
import { createFindTool } from "./find";
import { createLsTool } from "./ls";
import {
  emptySearchCoverage,
  hasSearchGaps,
  noResultWithCoverage,
  searchCoverageNotice,
} from "../ops/search-coverage";
import type { ToolTextContent } from "./types";

// root/
//   a.txt        "needle here"
//   b.txt        "nothing"
//   binary.bin   含 NUL → grep 跳过(缺口)
//   locked.txt   自定义 ops 读失败(缺口)
const root = mkdtempSync(join(tmpdir(), "rkh-coverage-"));
writeFileSync(join(root, "a.txt"), "needle here\n");
writeFileSync(join(root, "b.txt"), "nothing\n");
writeFileSync(join(root, "binary.bin"), Buffer.from([0x6e, 0x00, 0x6e]));
writeFileSync(join(root, "locked.txt"), "needle locked\n");

const grepOps = {
  isDirectory: (p: string) => p === root,
  readFile: async (p: string) => {
    if (p.endsWith("locked.txt")) throw new Error("EACCES");
    return fsReadFile(p);
  },
  statSize: async (p: string) => (await fsStat(p)).size,
};

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((c) => c.type === "text") as ToolTextContent[]).map((c) => c.text).join("\n");
}

describe("S5 grep 覆盖可见化", () => {
  test("有缺口时追加 Coverage 说明,计数进 details", async () => {
    const tool = createGrepTool(root, { operations: grepOps, coverageHonesty: true });
    const result = await tool.execute({ pattern: "needle" });
    const text = textOf(result);
    expect(text).toContain("a.txt:1: needle here");
    expect(text).toContain("[Coverage: searched 2 files; not searched: 1 binary file, 1 unreadable.");
    expect(text).toContain("Results may be incomplete");
    expect(result.details?.coverage).toEqual({
      scanned: 2,
      binary: 1,
      oversized: 0,
      unreadable: 1,
      visitCapReached: false,
    });
  });

  test("零匹配:不再给出「不存在」的总数断言", async () => {
    const tool = createGrepTool(root, { operations: grepOps, coverageHonesty: true });
    const result = await tool.execute({ pattern: "zzz-nothing" });
    const text = textOf(result);
    expect(text).toContain("No matches found");
    expect(text).toContain("this is not proof of absence");
    expect(text).toContain("1 binary file");
    expect(result.details?.coverage?.binary).toBe(1);
  });

  test("开关关闭:输出与历史逐字一致(缺口不改变文案)", async () => {
    const tool = createGrepTool(root, { operations: grepOps });
    expect(textOf(await tool.execute({ pattern: "zzz-nothing" }))).toBe("No matches found");
    const matched = await tool.execute({ pattern: "needle" });
    expect(textOf(matched)).toBe("a.txt:1: needle here");
    expect(matched.details).toBeUndefined();
  });

  test("超限文件计入 oversized,上限标签用实际生效值", async () => {
    const tool = createGrepTool(root, { operations: grepOps, coverageHonesty: true, maxFileBytes: 5 });
    const result = await tool.execute({ pattern: "needle" });
    const text = textOf(result);
    // a.txt/b.txt/locked.txt 都超过 5B → oversized;binary.bin 3B 读入 → binary。
    expect(text).toContain("3 over the 5B limit");
    expect(result.details?.coverage?.oversized).toBe(3);
    expect(result.details?.coverage?.scanned).toBe(0);
  });

  test("命中上限:说明里带已经扫过的文件数", async () => {
    const tool = createGrepTool(root, { operations: grepOps, coverageHonesty: true });
    const text = textOf(await tool.execute({ pattern: "needle", limit: 1 }));
    expect(text).toContain("1 matches limit reached. Use limit=2 for more");
    expect(text).toContain("Searched 1 files before the limit.");
  });

  test("description 仅在开关开启时追加覆盖说明", () => {
    expect(createGrepTool(root, { coverageHonesty: true }).description).toContain("Coverage reporting is on");
    expect(createGrepTool(root).description).not.toContain("Coverage reporting");
  });
});

describe("S5 find/ls 覆盖可见化", () => {
  test("find:无缺口零结果保持历史文案,上限说明带扫描数", async () => {
    const tool = createFindTool(root, { coverageHonesty: true });
    expect(textOf(await tool.execute({ pattern: "nope*" }))).toBe("No files found matching pattern");
    const limited = textOf(await tool.execute({ pattern: "*", limit: 2 }));
    expect(limited).toContain("2 results limit reached. Use limit=4 for more, or refine pattern");
    expect(limited).toContain("Searched 2 entries before the limit.");
  });

  test("ls:不可 stat 的条目计缺口,不再声称空目录", async () => {
    const dir = join(root, "only-locked");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.txt"), "x");
    const ops = {
      exists: () => true,
      stat: (p: string) => {
        if (p.endsWith("x.txt")) throw new Error("EACCES");
        return fsStat(p);
      },
      readdir: (p: string) => fsReaddir(p),
    };
    const tool = createLsTool(dir, { operations: ops, coverageHonesty: true });
    const result = await tool.execute({});
    const text = textOf(result);
    expect(text).toContain("(empty directory)");
    expect(text).toContain("1 unreadable");
    expect(result.details?.coverage?.unreadable).toBe(1);
  });

  test("ls:开关关闭时不可 stat 的条目仍按历史静默跳过", async () => {
    const dir = join(root, "only-locked-off");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.txt"), "x");
    const ops = {
      exists: () => true,
      stat: (p: string) => {
        if (p.endsWith("x.txt")) throw new Error("EACCES");
        return fsStat(p);
      },
      readdir: () => ["x.txt"],
    };
    const tool = createLsTool(dir, { operations: ops });
    expect(textOf(await tool.execute({}))).toBe("(empty directory)");
  });
});

describe("S5 覆盖文案纯函数", () => {
  test("无缺口不打扰", () => {
    const clean = emptySearchCoverage();
    expect(hasSearchGaps(clean)).toBe(false);
    expect(searchCoverageNotice(clean, { noun: "file", sizeLabel: "512KB" })).toBeNull();
    expect(noResultWithCoverage("No matches found", clean, { noun: "file", sizeLabel: "512KB" })).toBe("No matches found");
  });

  test("多类缺口合并成一句话", () => {
    const coverage = { scanned: 7, binary: 1, oversized: 2, unreadable: 3, visitCapReached: true };
    const notice = searchCoverageNotice(coverage, { noun: "file", sizeLabel: "512KB" });
    expect(notice).toContain("searched 7 files");
    expect(notice).toContain("1 binary file, 2 over the 512KB limit, 3 unreadable, directory traversal stopped at the visit cap");
  });
});
