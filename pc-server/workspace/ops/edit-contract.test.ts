// workspace/ops/edit-contract.test.ts — S3 expectedRevision / dryRun 回归
// 覆盖:成功编辑回灌新 revision、旧 revision 拒绝且不写盘、dryRun 无副作用、
// 多编辑整批原子、编辑期间文件被改动、参数校验。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditTool, type EditOperations } from "../tools/edit";
import type { ToolTextContent } from "../tools/types";
import {
  annotateEditResult,
  createEditContractOperations,
  EditRevisionConflictError,
  editParametersWithContract,
  readEditContractArgs,
  type EditContract,
} from "./edit-contract";
import { sha256Short } from "./revision";

const dir = mkdtempSync(join(tmpdir(), "rkh-edit-contract-"));

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content.filter((entry) => entry.type === "text") as ToolTextContent[])
    .map((entry) => entry.text)
    .join("\n");
}

function fileOps(): EditOperations {
  return {
    access: async () => {},
    readFile: async (absolutePath) => readFileSync(absolutePath),
    writeFile: async (absolutePath, content) => writeFileSync(absolutePath, content, "utf-8"),
  };
}

function makeTool(contract: EditContract, baseOps: EditOperations = fileOps()) {
  return createEditTool(dir, { operations: createEditContractOperations(baseOps, contract) });
}

describe("S3 edit 契约", () => {
  test("成功编辑:文件更新且回执带新 revision", async () => {
    const file = join(dir, "basic.txt");
    writeFileSync(file, "alpha beta", "utf-8");
    let info: { wrote: boolean; revision: string } | undefined;
    const tool = makeTool({
      expectedRevision: sha256Short(readFileSync(file)),
      dryRun: false,
      onWrite: (next) => { info = next; },
    });
    const raw = await tool.execute({ path: "basic.txt", edits: [{ oldText: "alpha", newText: "gamma" }] });
    expect(readFileSync(file, "utf-8")).toBe("gamma beta");
    expect(info?.wrote).toBe(true);
    const annotated = annotateEditResult(raw, info!);
    expect(textOf(annotated)).toContain("Successfully replaced 1 block(s) in basic.txt.");
    expect(textOf(annotated)).toContain(`New revision: ${sha256Short(readFileSync(file))}.`);
  });

  test("旧 revision:结构化冲突且不写盘", async () => {
    const file = join(dir, "stale.txt");
    writeFileSync(file, "alpha", "utf-8");
    const currentRevision = sha256Short(readFileSync(file));
    const tool = makeTool({ expectedRevision: "deadbeefdeadbeefdeadbeefdeadbeef", dryRun: false });
    let caught: unknown;
    try {
      await tool.execute({ path: "stale.txt", edits: [{ oldText: "alpha", newText: "gamma" }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EditRevisionConflictError);
    const conflict = caught as EditRevisionConflictError;
    expect(conflict.code).toBe("edit_revision_conflict");
    expect(conflict.effectState).toBe("none");
    expect(conflict.currentRevision).toBe(currentRevision);
    expect(conflict.message).toContain("effectState: none");
    expect(conflict.message).toContain(currentRevision);
    expect(readFileSync(file, "utf-8")).toBe("alpha");
  });

  test("dryRun:不写盘但产出 diff 与 would-be revision", async () => {
    const file = join(dir, "dry.txt");
    writeFileSync(file, "alpha", "utf-8");
    let info: { wrote: boolean; revision: string } | undefined;
    const tool = makeTool({
      expectedRevision: sha256Short(readFileSync(file)),
      dryRun: true,
      onWrite: (next) => { info = next; },
    });
    const raw = await tool.execute({ path: "dry.txt", edits: [{ oldText: "alpha", newText: "beta" }] });
    expect(readFileSync(file, "utf-8")).toBe("alpha");
    expect(info?.wrote).toBe(false);
    expect(info?.revision).toBe(sha256Short("beta"));
    expect(raw.details?.diff).toContain("beta");
    const annotated = annotateEditResult(raw, info!);
    expect(textOf(annotated)).toContain("Dry run: no file was written.");
    expect(textOf(annotated)).toContain(`Would-be revision: ${info!.revision}.`);
  });

  test("多编辑整批原子:任一 oldText 失配则不写盘", async () => {
    const file = join(dir, "atomic.txt");
    writeFileSync(file, "alpha\nbeta", "utf-8");
    const tool = makeTool({ expectedRevision: sha256Short(readFileSync(file)), dryRun: false });
    await expect(
      tool.execute({
        path: "atomic.txt",
        edits: [
          { oldText: "alpha", newText: "A" },
          { oldText: "missing", newText: "B" },
        ],
      }),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf-8")).toBe("alpha\nbeta");
  });

  test("编辑准备期间文件被改动:拒绝写入", async () => {
    let reads = 0;
    const base: EditOperations = {
      access: async () => {},
      readFile: async () => {
        reads += 1;
        // 第一次是内核读(编辑基线),第二次是写前复核(模拟人类刚改过)。
        return Buffer.from(reads === 1 ? "alpha" : "alpha changed", "utf-8");
      },
      writeFile: async () => {
        throw new Error("should not write");
      },
    };
    const tool = makeTool({ expectedRevision: sha256Short("alpha"), dryRun: false }, base);
    await expect(
      tool.execute({ path: "racy.txt", edits: [{ oldText: "alpha", newText: "gamma" }] }),
    ).rejects.toThrow("changed while the edit was being prepared");
  });

  test("参数解析:非法类型整单拒绝,缺省保持旧行为", () => {
    expect(readEditContractArgs({ path: "x" })).toEqual({ ok: true, contract: { dryRun: false } });
    expect(readEditContractArgs({ path: "x", expectedRevision: "  abc  ", dryRun: true })).toEqual({
      ok: true,
      contract: { expectedRevision: "abc", dryRun: true },
    });
    expect(readEditContractArgs({ path: "x", expectedRevision: 42 }).ok).toBe(false);
    expect(readEditContractArgs({ path: "x", dryRun: "yes" }).ok).toBe(false);
  });

  test("声明面:补两个可选参数且不破坏原有 required", () => {
    const parameters = {
      type: "object",
      properties: { path: { type: "string" }, edits: { type: "array" } },
      required: ["path", "edits"],
    };
    const withContract = editParametersWithContract(parameters);
    const properties = withContract.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["path", "edits", "expectedRevision", "dryRun"]);
    expect(withContract.required).toEqual(["path", "edits"]);
  });
});
