// workspace/tools/resume-truncation.test.ts — S6 截断结果可续读回归
// 覆盖:bash 落盘提示升级(总量/路径/read 分页/文件内 grep)、关闭时逐字保持 pi 原文案;
// grep/find/ls 命中上限时完整结果落盘 + 续读说明;落盘文件只在注入的工作区 tmp/;
// 关闭时不写任何文件;安全帽文案写成 "N+"。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool } from "./bash";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { capRenderedLines, searchResumeNotice } from "../ops/resume-truncation";
import type { ToolTextContent } from "./types";

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((c) => c.type === "text") as ToolTextContent[]).map((c) => c.text).join("\n");
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "rkh-resume-"));
}

/** bash 假执行手:一次性吐完给定文本。 */
function bashOpsOf(text: string) {
  return {
    exec: async (
      _command: string,
      _cwd: string,
      options: { onData: (data: Buffer) => void },
    ): Promise<{ exitCode: number | null }> => {
      options.onData(Buffer.from(text));
      return { exitCode: 0 };
    },
  };
}

describe("S6 bash:落盘提示带总量与续读指引", () => {
  const bigText = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";

  test("开关开启:总量 + 路径 + read 分页 + 文件内 grep", async () => {
    const root = makeRoot();
    const tempFileDir = join(root, "tmp");
    const tool = createBashTool(root, { operations: bashOpsOf(bigText), tempFileDir, resumableOutput: true });
    const result = await tool.execute({ command: "whatever" });
    const text = textOf(result);
    expect(text).toContain("Showing lines 501-2500 of 2500");
    expect(text).toContain("Full output saved to ");
    expect(text).toContain("read tool (offset/limit)");
    expect(text).toContain("grep within it");
    expect(text).toContain("instead of re-running the command");
    expect(tool.description).toContain("page through it with read");
    // 落盘文件在注入的工作区 tmp/ 内,内容完整。
    const path = result.details?.fullOutputPath as string;
    expect(path.startsWith(tempFileDir)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(bigText);
  });

  test("开关关闭:逐字保持 pi 原文案,不出现新指引", async () => {
    const root = makeRoot();
    const tempFileDir = join(root, "tmp");
    const tool = createBashTool(root, { operations: bashOpsOf(bigText), tempFileDir });
    const result = await tool.execute({ command: "whatever" });
    const text = textOf(result);
    const path = result.details?.fullOutputPath as string;
    expect(text).toContain(`[Showing lines 501-2500 of 2500. Full output: ${path}]`);
    expect(text).not.toContain("saved to");
    expect(text).not.toContain("page through");
    expect(tool.description).not.toContain("page through");
  });
});

describe("S6 grep:命中上限后完整结果落盘", () => {
  function makeGrepRoot() {
    const root = makeRoot();
    writeFileSync(join(root, "match.txt"), Array.from({ length: 10 }, (_, i) => `hit-${i + 1}`).join("\n") + "\n");
    return root;
  }

  test("显示仍按上限,尾部给出总量与落盘路径", async () => {
    const root = makeGrepRoot();
    const tempFileDir = join(root, "tmp");
    const tool = createGrepTool(root, { resumeTruncatedOutput: true, tempFileDir });
    const result = await tool.execute({ pattern: "hit", limit: 3 });
    const text = textOf(result);
    expect(text).toContain("3 matches limit reached");
    expect(text).toContain("10 matches collected in total and saved to ");
    expect(text).toContain("page through it with the read tool (offset/limit) or grep within it");
    const path = result.details?.fullOutputPath as string;
    expect(path.startsWith(tempFileDir)).toBe(true);
    const saved = readFileSync(path, "utf-8").trimEnd().split("\n");
    expect(saved).toHaveLength(10);
    expect(saved[0]).toBe("match.txt:1: hit-1");
    expect(saved[9]).toBe("match.txt:10: hit-10");
  });

  test("开关关闭:不落盘、文案与历史一致", async () => {
    const root = makeGrepRoot();
    const tempFileDir = join(root, "tmp");
    const tool = createGrepTool(root, { tempFileDir });
    const result = await tool.execute({ pattern: "hit", limit: 3 });
    const text = textOf(result);
    expect(text).toContain("3 matches limit reached. Use limit=6 for more, or refine pattern");
    expect(text).not.toContain("collected in total");
    expect(result.details?.fullOutputPath).toBeUndefined();
    expect(existsSync(tempFileDir)).toBe(false);
  });
});

describe("S6 find:结果上限落盘", () => {
  test("显示按上限,落盘含全部结果", async () => {
    const root = makeRoot();
    for (const name of ["a.css", "b.css", "c.css", "d.css", "e.css"]) writeFileSync(join(root, name), "");
    const tempFileDir = join(root, "tmp");
    const tool = createFindTool(root, { resumeTruncatedOutput: true, tempFileDir });
    const result = await tool.execute({ pattern: "*.css", limit: 2 });
    const text = textOf(result);
    expect(text).toContain("2 results limit reached");
    expect(text).toContain("5 results collected in total and saved to ");
    const path = result.details?.fullOutputPath as string;
    expect(readFileSync(path, "utf-8").trimEnd().split("\n")).toEqual([
      "a.css",
      "b.css",
      "c.css",
      "d.css",
      "e.css",
    ]);
  });
});

describe("S6 ls:条目上限落盘", () => {
  test("显示按上限,落盘含全部条目", async () => {
    const root = makeRoot();
    const dir = join(root, "listing");
    mkdirSync(dir);
    for (const name of ["1.txt", "2.txt", "3.txt", "4.txt"]) writeFileSync(join(dir, name), "");
    const tempFileDir = join(root, "tmp");
    const tool = createLsTool(dir, { resumeTruncatedOutput: true, tempFileDir });
    const result = await tool.execute({ limit: 2 });
    const text = textOf(result);
    expect(text).toContain("2 entries limit reached");
    expect(text).toContain("4 entries collected in total and saved to ");
    const path = result.details?.fullOutputPath as string;
    expect(readFileSync(path, "utf-8").trimEnd().split("\n")).toEqual(["1.txt", "2.txt", "3.txt", "4.txt"]);
  });
});

describe("S6 落盘文案与字节帽纯函数", () => {
  test("安全帽:写成 N+ 而不是伪精确总数", () => {
    const notice = searchResumeNotice(
      { path: "/ws/tmp/pi-grep-abcd.log", lineCount: 5000, bytes: 4096 },
      { noun: "match", capReached: true },
    );
    expect(notice).toContain("5000+ matches collected in total");
    expect(notice).toContain("page through it with the read tool (offset/limit) or grep within it");
  });

  test("单条也是复数语法;字节帽保留完整行", () => {
    expect(searchResumeNotice({ path: "/x", lineCount: 1, bytes: 10 }, { noun: "result", capReached: false }))
      .toContain("1 result collected in total");
    const capped = capRenderedLines(["aaaa", "bbbb"], 6);
    expect(capped).toEqual({ lines: ["aaaa"], capReached: true });
    expect(capRenderedLines(["aaaa"], 6)).toEqual({ lines: ["aaaa"], capReached: false });
  });
});
