// workspace/ops/edit-contract.ts — S3:编辑版本前置(expectedRevision / dryRun)
//
// 落点纪律:不改 workspace/tools/edit.ts 的 pi 移植内核,把契约注入到 EditOperations:
// 内核在 withFileMutationQueue 内先 readFile 后 writeFile,天然满足"校验与写入在同一
// 串行队列内"。包装层借此:
//   - readFile 记住本次编辑所基于的 revision;
//   - writeFile 在真正落盘前读当前文件复核 revision,不符即抛结构化冲突且不写;
//   - dryRun 时跳过写入,但仍产出内核的 diff/patch(预览)。
// 语义边界(计划书原文):只保证 agent 写通路内的串行校验,不承诺跨进程强一致——
// 人类在侧边栏保存走自己的 etag 检查(workspace/files.ts),两者在毫秒级窗口内仍可能
// 交错,但任何一方都不会在检测到版本不符时静默覆盖。
//
// 回灌:成功写入后把新 revision 附到工具回执,模型可以在同一轮继续链式编辑;dryRun
// 明确标注"未写盘",避免模型把预览当已完成。

import type { EditOperations } from "../tools/edit";
import type { JsonValue } from "../../foundation/types";
import type { WorkspaceToolOutput } from "../tools/types";
import { sha256Short } from "./revision";

export interface EditWriteInfo {
  /** false = dryRun,文件未被修改。 */
  wrote: boolean;
  /** 写入后的 revision(dryRun 时是"假如写入"的 revision)。 */
  revision: string;
}

export interface EditContract {
  expectedRevision?: string;
  dryRun: boolean;
  onWrite?: (info: EditWriteInfo) => void;
}

export class EditRevisionConflictError extends Error {
  readonly code = "edit_revision_conflict";
  readonly effectState = "none";
  readonly expectedRevision: string;
  readonly currentRevision: string;

  constructor(expectedRevision: string, currentRevision: string, detail: string) {
    super(
      `Edit rejected: ${detail} (expected revision ${expectedRevision}, current revision ${currentRevision}). `
        + "The file was NOT modified (effectState: none). "
        + "Read the file again to get the current content and revision, then retry the edit.",
    );
    this.name = "EditRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** 参数面解析:只在契约开关开启的调用点使用;非法类型直接拒绝(不静默忽略)。 */
export function readEditContractArgs(
  args: Record<string, JsonValue>,
): { ok: true; contract: Omit<EditContract, "onWrite"> } | { ok: false; error: string } {
  const rawRevision = args.expectedRevision;
  if (rawRevision !== undefined && typeof rawRevision !== "string") {
    return { ok: false, error: "expectedRevision must be a string (the revision returned by read)." };
  }
  const rawDryRun = args.dryRun;
  if (rawDryRun !== undefined && typeof rawDryRun !== "boolean") {
    return { ok: false, error: "dryRun must be a boolean." };
  }
  const expectedRevision = typeof rawRevision === "string" ? rawRevision.trim() : "";
  return {
    ok: true,
    contract: {
      ...(expectedRevision ? { expectedRevision } : {}),
      dryRun: rawDryRun === true,
    },
  };
}

/** 包装编辑操作:revision 复核 + dryRun 跳写。每次 createEditTool 都应新建一份。 */
export function createEditContractOperations(base: EditOperations, contract: EditContract): EditOperations {
  let basedOnRevision: string | null = null;
  return {
    access: (absolutePath) => base.access(absolutePath),
    readFile: async (absolutePath) => {
      const buffer = await base.readFile(absolutePath);
      basedOnRevision = sha256Short(buffer);
      return buffer;
    },
    writeFile: async (absolutePath, content) => {
      const nextRevision = sha256Short(Buffer.from(content, "utf8"));
      if (contract.expectedRevision) {
        const currentRevision = sha256Short(await base.readFile(absolutePath));
        if (basedOnRevision !== null && basedOnRevision !== currentRevision) {
          throw new EditRevisionConflictError(
            contract.expectedRevision,
            currentRevision,
            "the file changed while the edit was being prepared",
          );
        }
        if (currentRevision !== contract.expectedRevision) {
          throw new EditRevisionConflictError(contract.expectedRevision, currentRevision, "the file has changed since it was read");
        }
      }
      if (!contract.dryRun) await base.writeFile(absolutePath, content);
      contract.onWrite?.({ wrote: !contract.dryRun, revision: nextRevision });
    },
  };
}

/** 回执改写:成功编辑附新 revision;dryRun 明确"未写盘"且用虚拟语气。 */
export function annotateEditResult(output: WorkspaceToolOutput<unknown>, info: EditWriteInfo): WorkspaceToolOutput<unknown> {
  const first = output.content[0];
  if (!first || first.type !== "text") return output;
  const text = info.wrote
    ? `${first.text} New revision: ${info.revision}.`
    : `Dry run: no file was written. ${first.text.replace("Successfully replaced", "Would replace")} Would-be revision: ${info.revision}.`;
  return {
    ...output,
    content: [{ type: "text", text }, ...output.content.slice(1)],
  };
}

/** 声明面:契约开启时给 edit 的 schema 补两个可选参数(关闭时逐字保持旧声明)。 */
export function editParametersWithContract(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = (parameters.properties ?? {}) as Record<string, unknown>;
  return {
    ...parameters,
    properties: {
      ...properties,
      expectedRevision: {
        type: "string",
        description:
          "Revision returned by the last read of this file. When provided, the edit is rejected without writing if the file has changed since that read.",
      },
      dryRun: {
        type: "boolean",
        description: "Preview the edit without writing. Returns the diff and the revision the file would have.",
      },
    },
  };
}
