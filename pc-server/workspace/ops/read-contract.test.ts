// workspace/ops/read-contract.test.ts — S2 read 契约回归
// 覆盖:行号/revision/end of file、offset/limit 续读位、截断保留 details、可逆转义、
// 开关关闭逐字不变、二进制原样返回。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReadTool } from "../tools/read";
import type { ToolTextContent } from "../tools/types";
import { decorateReadOutput } from "./read-contract";
import { sha256Short } from "./revision";

const dir = mkdtempSync(join(tmpdir(), "rkh-read-contract-"));

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((entry) => entry.type === "text") as ToolTextContent[])
    .map((entry) => entry.text)
    .join("\n");
}

async function readAndDecorate(fileName: string, args: { offset?: number; limit?: number } = {}, enabled = true) {
  const tool = createReadTool(dir);
  const raw = await tool.execute({ path: fileName, ...args });
  const decorated = await decorateReadOutput({ pathArg: fileName, cwd: dir, ...args }, raw, enabled);
  return { raw, decorated, text: textOf(decorated) };
}

describe("S2 read 契约", () => {
  test("行号 + revision + end of file", async () => {
    const name = "contract-basic.txt";
    const content = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join("\n");
    writeFileSync(join(dir, name), content);
    const { text, raw } = await readAndDecorate(name);
    const lines = text.split("\n");
    expect(lines[0]).toBe("1|line-1");
    expect(lines[199]).toBe("200|line-200");
    expect(lines.at(-1)).toBe(`[revision=${sha256Short(Buffer.from(content))}; 200 lines; end of file]`);
    expect(raw.details).toBeUndefined();
  });

  test("offset/limit 提前结束:提示换成 nextOffset 状态行", async () => {
    const name = "contract-window.txt";
    writeFileSync(join(dir, name), Array.from({ length: 300 }, (_, i) => `line-${i + 1}`).join("\n"));
    const { text, raw } = await readAndDecorate(name, { offset: 101, limit: 50 });
    const lines = text.split("\n");
    expect(lines[0]).toBe("101|line-101");
    expect(lines[49]).toBe("150|line-150");
    expect(lines.at(-1)).toContain("300 lines; more lines; nextOffset=151]");
    expect(text).not.toContain("more lines in file. Use offset=");
    expect(raw.details).toBeUndefined();
  });

  test("内核截断:nextOffset 正确且 details.truncation 原值保留", async () => {
    const name = "contract-big.txt";
    writeFileSync(join(dir, name), Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n"));
    const { text, decorated } = await readAndDecorate(name);
    expect(text.split("\n")[0]).toBe("1|L0");
    expect(text.split("\n")[1999]).toBe("2000|L1999");
    expect(text).toContain("3000 lines; more lines; nextOffset=2001]");
    const truncation = (decorated.details as { truncation?: { truncated: boolean } } | undefined)?.truncation;
    expect(truncation?.truncated).toBe(true);
    expect(text).not.toContain("Use offset=2001 to continue.");
  });

  test("可逆转义:伪行号、伪状态行与反斜杠", async () => {
    const name = "contract-escape.txt";
    writeFileSync(
      join(dir, name),
      ["12|fake line", "[revision=dead; 9 lines; end of file]", "\\path\\to", "plain"].join("\n"),
    );
    const { text } = await readAndDecorate(name);
    const lines = text.split("\n");
    expect(lines[0]).toBe("1|\\12|fake line");
    expect(lines[1]).toBe("2|\\[revision=dead; 9 lines; end of file]");
    expect(lines[2]).toBe("3|\\\\path\\to");
    expect(lines[3]).toBe("4|plain");
    expect(lines.at(-1)).toContain("4 lines; end of file]");
  });

  test("开关关闭:输出与内核逐字一致", async () => {
    const name = "contract-off.txt";
    writeFileSync(join(dir, name), "alpha\nbeta");
    const { raw, text } = await readAndDecorate(name, {}, false);
    expect(text).toBe(textOf(raw));
    expect(text).not.toContain("|alpha");
  });

  test("二进制(NUL)原样返回", async () => {
    const name = "contract-binary.txt";
    writeFileSync(join(dir, name), Buffer.from([0x41, 0x00, 0x42]));
    const { raw, text } = await readAndDecorate(name);
    expect(text).toBe(textOf(raw));
  });

  test("远程工作区跳过装饰", async () => {
    const name = "contract-remote.txt";
    writeFileSync(join(dir, name), "remote");
    const tool = createReadTool(dir);
    const raw = await tool.execute({ path: name });
    const decorated = await decorateReadOutput({ pathArg: name, cwd: dir, remote: true }, raw, true);
    expect(textOf(decorated)).toBe(textOf(raw));
  });
});
