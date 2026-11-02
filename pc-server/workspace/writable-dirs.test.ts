// writable-dirs.test.ts — 沙盒额外可写目录的规范化与危险根拦截(Windows 专用,其余跳过)
// 这些校验在保存前拦住"手滑把 C:\ 标成 Low",标注动作本身由 labeling.test.ts 覆盖。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectDeclaredWritableDirs,
  normalizeSandboxWritableDirs,
  rejectWritableDirReason,
} from "./writable-dirs";

const onWindows = process.platform === "win32";
const suite = onWindows ? describe : describe.skip;

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rikkahub-writable-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 残留无害
    }
  }
});

suite("normalizeSandboxWritableDirs", () => {
  test("接受普通绝对目录,去引号、去尾分隔符、大小写不敏感去重", () => {
    const dir = makeDir();
    const outcome = normalizeSandboxWritableDirs([
      `"${dir}"`, // 资源管理器「复制为路径」带引号
      `${dir}\\`, // 尾分隔符
      dir.toUpperCase(), // 同一目录的另一种大小写
      "  ", // 空白
      42, // 非字符串
    ]);
    expect(outcome.invalid).toEqual([]);
    expect(outcome.dirs.map((item) => item.toLowerCase())).toEqual([dir.toLowerCase()]);
  });

  test("相对路径被拒绝而非被静默接受", () => {
    const outcome = normalizeSandboxWritableDirs(["tools/data", ".\\cache"]);
    expect(outcome.dirs).toEqual([]);
    expect(outcome.invalid).toHaveLength(2);
  });

  test("UNC 路径按绝对路径接受", () => {
    expect(rejectWritableDirReason("\\\\nas\\vol1\\tools\\cache")).toBeNull();
  });
});

suite("rejectWritableDirReason", () => {
  test("盘符根目录一律拒绝", () => {
    expect(rejectWritableDirReason("C:\\")).not.toBeNull();
    expect(rejectWritableDirReason("D:/")).not.toBeNull();
  });

  test("系统目录、用户目录根及其上级被拒绝", () => {
    const roots = [
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env.ProgramData,
      process.env.USERPROFILE,
    ];
    for (const root of roots) {
      if (!root) continue;
      expect(rejectWritableDirReason(root)).not.toBeNull();
      expect(rejectWritableDirReason(`${root}\\`)).not.toBeNull();
    }
    if (process.env.USERPROFILE) {
      // C:\Users 这类"用户目录的上级"同样过宽。
      const parent = join(process.env.USERPROFILE, "..");
      expect(rejectWritableDirReason(parent)).not.toBeNull();
    }
  });

  test("受保护根的下级子目录正常放行", () => {
    // 临时目录位于用户目录之下,正是"更深的子目录允许"的用例。
    expect(rejectWritableDirReason(makeDir())).toBeNull();
  });
});

suite("collectDeclaredWritableDirs", () => {
  test("合并全局列表与 stdio 服务器自己的列表,跳过 http 服务器", () => {
    const a = makeDir();
    const b = makeDir();
    const dirs = collectDeclaredWritableDirs({
      sandboxExtraWritableDirs: [a],
      mcpServers: [
        { type: "stdio", command: "npx", sandboxWritableDirs: [b] },
        { type: "http", url: "http://127.0.0.1:3333", sandboxWritableDirs: [makeDir()] },
      ],
    });
    expect(dirs.map((item) => item.toLowerCase()).sort()).toEqual(
      [a.toLowerCase(), b.toLowerCase()].sort(),
    );
  });

  test("缺字段、类型不对、非对象一律按空列表处理", () => {
    expect(collectDeclaredWritableDirs(undefined)).toEqual([]);
    expect(collectDeclaredWritableDirs(null)).toEqual([]);
    expect(collectDeclaredWritableDirs("settings")).toEqual([]);
    expect(collectDeclaredWritableDirs({ sandboxExtraWritableDirs: "not-an-array" })).toEqual([]);
    expect(collectDeclaredWritableDirs({ mcpServers: [null, 7, { type: "stdio" }] })).toEqual([]);
  });
});
