// workspace/boundary-snapshot.ts — 权限边界快照的单一构造点(O4)
//
// 审批判定与执行保护都从这里取快照,保证"审批时的边界"与"执行时的边界"字段口径一致;
// 两者是否同一份快照由 boundaryIdFor(稳定字段)决定,而不是各自拼字段后互相猜测。

import type { Workspace } from "../foundation/types";
import type { ToolBoundarySnapshot, ToolBoundaryWriteScope } from "../foundation/tool-boundary";
import { sandboxStatus } from "./sandbox";

export function buildWorkspaceBoundarySnapshot(
  workspace: Workspace,
  cwd: string,
  effectiveWriteScope: ToolBoundaryWriteScope,
): ToolBoundarySnapshot {
  // SSH 工作区只挂 read + bash(无 write/edit):远端 shell 本来就不受目录边界约束,
  // 本机系统沙盒也不约束远端命令。按"宽写 + 无本机沙盒"如实记录,避免把本机
  // 低完整性边界冒充成远端边界。measured=unknown 表示远端边界未实测。
  const remote = workspace.type === "ssh";
  const sandbox = remote ? null : sandboxStatus();
  return {
    workspace: {
      id: workspace.id,
      // managed/folder 都是本机工作区;边界语义只区分本地/SSH。
      type: remote ? "ssh" : "local",
      root: workspace.root,
      cwd,
    },
    permissionPreset: workspace.permissionPreset,
    effectiveWriteScope: remote ? "wide" : effectiveWriteScope,
    sandbox: sandbox
      ? {
          tier: sandbox.tier,
          measured: sandbox.measured,
          boundaryActive: sandbox.boundaryActive,
          mechanism: sandbox.mechanism,
          checkedAt: sandbox.checkedAt,
        }
      : {
          tier: "off",
          measured: "unknown",
          boundaryActive: false,
          mechanism: "none",
          checkedAt: Date.now(),
        },
  };
}
