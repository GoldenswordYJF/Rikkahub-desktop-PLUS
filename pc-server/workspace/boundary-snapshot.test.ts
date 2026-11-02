// workspace/boundary-snapshot.test.ts — O4 边界快照构造口径
//
// 钉住:本地工作区沿用系统沙盒状态;SSH 工作区不把本机沙盒冒充成远端边界,
// 且远端 shell 不受目录写边界约束(宽写)。
import { describe, expect, test } from "bun:test";

import type { Workspace } from "../foundation/types";
import { buildWorkspaceBoundarySnapshot } from "./boundary-snapshot";

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    name: "w",
    type: "managed",
    root: "/work",
    permissionPreset: "balanced",
    trustedAt: 1,
    sshDeviceId: null,
    sshDirId: null,
    createAt: 1,
    updateAt: 1,
    lastAccessAt: 1,
    ...overrides,
  };
}

describe("边界快照构造", () => {
  test("本地工作区保留调用方给定的有效写边界", () => {
    const snapshot = buildWorkspaceBoundarySnapshot(workspace({}), "/work/sub", "strict");
    expect(snapshot.workspace).toEqual({ id: "ws-1", type: "local", root: "/work", cwd: "/work/sub" });
    expect(snapshot.permissionPreset).toBe("balanced");
    expect(snapshot.effectiveWriteScope).toBe("strict");
    expect(typeof snapshot.sandbox.checkedAt).toBe("number");
  });

  test("SSH 工作区:宽写、无本机沙盒、远端未知实测", () => {
    const snapshot = buildWorkspaceBoundarySnapshot(
      workspace({
        id: "ws-ssh",
        type: "ssh",
        root: "/srv/app",
        permissionPreset: "confirm_each",
        sshDeviceId: "dev-1",
        sshDirId: "dir-1",
      }),
      "/srv/app",
      "strict",
    );
    expect(snapshot.workspace).toEqual({ id: "ws-ssh", type: "ssh", root: "/srv/app", cwd: "/srv/app" });
    expect(snapshot.permissionPreset).toBe("confirm_each");
    expect(snapshot.effectiveWriteScope).toBe("wide");
    expect(snapshot.sandbox).toMatchObject({
      tier: "off",
      measured: "unknown",
      boundaryActive: false,
      mechanism: "none",
    });
  });
});
