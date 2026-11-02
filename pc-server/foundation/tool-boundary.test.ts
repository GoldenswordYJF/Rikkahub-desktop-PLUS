// foundation/tool-boundary.test.ts — O4 边界身份与快照解析契约
//
// 钉住:身份只认稳定字段(checkedAt/stage/access/targetScope 不参与),路径按工作区类型
// 归一;坏 payload 解析为 null 而不是伪造"无边界"。
import { describe, expect, test } from "bun:test";

import {
  boundaryIdFor,
  boundaryIdentityKey,
  observeToolBoundarySafely,
  parseBoundarySnapshot,
  type ToolBoundarySnapshot,
} from "./tool-boundary";

function snapshot(overrides: Partial<ToolBoundarySnapshot> = {}): ToolBoundarySnapshot {
  return {
    workspace: {
      id: "ws-1",
      type: "local",
      root: process.platform === "win32" ? "C:\\Work\\Demo" : "/work/demo",
      cwd: process.platform === "win32" ? "C:\\Work\\Demo" : "/work/demo",
    },
    permissionPreset: "balanced",
    effectiveWriteScope: "strict",
    sandbox: {
      tier: "restricted",
      measured: "enforced",
      boundaryActive: true,
      mechanism: "windows_integrity",
      checkedAt: 1_000,
    },
    ...overrides,
  };
}

describe("边界身份", () => {
  test("checkedAt 只是元数据:同一快照不同检查时刻仍复用同一 boundaryId", () => {
    const a = snapshot();
    const b = snapshot({ sandbox: { ...a.sandbox, checkedAt: 9_999 } });
    expect(boundaryIdentityKey(b)).toBe(boundaryIdentityKey(a));
    expect(boundaryIdFor(b)).toBe(boundaryIdFor(a));
    expect(boundaryIdFor(a)).toMatch(/^b[0-9a-f]{12}$/);
  });

  test("权限档/写边界/沙箱状态/根目录任一变化都产生新身份", () => {
    const base = snapshot();
    const id = boundaryIdFor(base);
    expect(boundaryIdFor(snapshot({ permissionPreset: "full_access" }))).not.toBe(id);
    expect(boundaryIdFor(snapshot({ effectiveWriteScope: "wide" }))).not.toBe(id);
    expect(
      boundaryIdFor(
        snapshot({ sandbox: { ...base.sandbox, boundaryActive: false, measured: "not_enforced" } }),
      ),
    ).not.toBe(id);
    expect(
      boundaryIdFor(
        snapshot({
          workspace: { ...base.workspace, root: `${base.workspace.root}-other` },
        }),
      ),
    ).not.toBe(id);
  });

  test("本地路径按平台归一,SSH 路径保持大小写", () => {
    if (process.platform === "win32") {
      const a = snapshot();
      const b = snapshot({
        workspace: { ...a.workspace, root: "c:/work/demo/", cwd: "C:\\work\\DEMO" },
      });
      expect(boundaryIdFor(b)).toBe(boundaryIdFor(a));
    }
    const sshA = snapshot({
      workspace: { id: "ws-ssh", type: "ssh", root: "/srv/app", cwd: "/srv/app" },
    });
    const sshB = snapshot({
      workspace: { id: "ws-ssh", type: "ssh", root: "/srv/App", cwd: "/srv/app" },
    });
    expect(boundaryIdFor(sshB)).not.toBe(boundaryIdFor(sshA));
  });
});

describe("快照解析", () => {
  test("扁平 payload 往返;缺字段或类型不符返回 null", () => {
    const value = snapshot();
    const parsed = parseBoundarySnapshot({ boundaryId: "b1234567890a", ...value });
    expect(parsed).toEqual(value);
    expect(parseBoundarySnapshot({ boundaryId: "b1" })).toBeNull();
    expect(
      parseBoundarySnapshot({
        workspace: value.workspace,
        permissionPreset: "whatever",
        effectiveWriteScope: value.effectiveWriteScope,
        sandbox: value.sandbox,
      }),
    ).toBeNull();
  });
});

describe("observer 容错", () => {
  test("观察者抛错被吞掉,不影响调用方", () => {
    expect(() =>
      observeToolBoundarySafely(
        () => {
          throw new Error("observer boom");
        },
        {
          toolCallId: "tc-1",
          stage: "execution",
          access: "write",
          targetScope: "inside",
          snapshot: snapshot(),
        },
      ),
    ).not.toThrow();
    expect(() => observeToolBoundarySafely(undefined, {
      toolCallId: "tc-1",
      stage: "execution",
      access: "write",
      targetScope: "inside",
      snapshot: snapshot(),
    })).not.toThrow();
  });
});
