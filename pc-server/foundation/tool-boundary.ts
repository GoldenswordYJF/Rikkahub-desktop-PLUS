// foundation/tool-boundary.ts — O4 权限边界观测契约(纯类型 + 纯函数)
//
// 定位:审批判定(tools/approval.ts)与执行保护/有效写边界(workspace/runtime.ts)各自
// 在最终决策点产出一份不可变快照,由编排层注入的 observer 适配到当前 run tracker。
// 本文件不 import workspace/api/agent-loop,避免 tools/workspace 层反向依赖上层。
//
// 去重身份只包含稳定快照字段(工作区、权限档、有效写边界、系统沙盒);stage/access/
// targetScope 是一次调用的使用语境,不参与快照去重。boundaryId 由规范化身份的摘要
// 决定:同一 run 内同一快照天然复用同一个 id,跨 resume 也无需重建内存映射。

import { createHash } from "node:crypto";
import type { ToolApprovalReasonCode, WorkspacePermissionPreset } from "./types";

export type ToolBoundaryStage = "approval" | "execution";
export type ToolBoundaryAccess = "read" | "write" | "execute";
export type ToolBoundaryTargetScope = "inside" | "outside" | "unknown";
export type ToolBoundaryWriteScope = "strict" | "wide";
export type ToolBoundarySandboxTier = "off" | "restricted" | "full";
export type ToolBoundarySandboxMeasurement = "enforced" | "not_enforced" | "unknown";
export type ToolBoundarySandboxMechanism = "windows_integrity" | "container_mounts" | "none";

/** run 内可复用、不可变的稳定快照。root/cwd 是复盘依据,不复制完整命令与工具输出。 */
export interface ToolBoundarySnapshot {
  workspace: {
    id: string;
    type: "local" | "ssh";
    root: string;
    cwd: string;
  };
  permissionPreset: WorkspacePermissionPreset;
  effectiveWriteScope: ToolBoundaryWriteScope;
  sandbox: {
    tier: ToolBoundarySandboxTier;
    measured: ToolBoundarySandboxMeasurement;
    boundaryActive: boolean;
    mechanism: ToolBoundarySandboxMechanism;
    checkedAt: number;
  };
}

/** pending 审批的白名单结构化缘由:短缘由去路径化,完整 reason 仍留在 approvalState。 */
export interface ToolBoundaryApprovalMeta {
  reasonCode: ToolApprovalReasonCode;
  reasonSummary?: string;
  ruleId?: string;
}

/** 一次工具调用的边界观察。stage=approval 表示最终审批判定;stage=execution 表示
 *  实际执行前的有效边界。两者分别记录,不互相冒充。 */
export interface ToolBoundaryObservation {
  toolCallId: string;
  toolName?: string;
  stage: ToolBoundaryStage;
  access: ToolBoundaryAccess;
  targetScope: ToolBoundaryTargetScope;
  snapshot: ToolBoundarySnapshot;
  /** 仅 stage=approval 携带。 */
  approval?: ToolBoundaryApprovalMeta;
}

export type ToolBoundaryObserver = (observation: ToolBoundaryObservation) => void;

/** observer 是纯观测:抛错/未注入都不能影响审批或执行。 */
export function observeToolBoundarySafely(
  observer: ToolBoundaryObserver | undefined,
  observation: ToolBoundaryObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch {
    /* 观测失败只降级为不可见 */
  }
}

function normalizeSnapshotPath(path: string, type: "local" | "ssh"): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (type === "ssh") return trimmed;
  const unified = trimmed.replace(/\\/g, "/");
  // Windows 本地路径大小写不敏感;POSIX 本地路径保持原样,避免把不同目录并成一个边界。
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** 去重身份:字段顺序固定,路径按平台归一,排除 checkedAt(元数据,不是边界本身)。 */
export function boundaryIdentityKey(snapshot: ToolBoundarySnapshot): string {
  const type = snapshot.workspace.type;
  return JSON.stringify({
    workspace: {
      id: snapshot.workspace.id,
      type,
      root: normalizeSnapshotPath(snapshot.workspace.root, type),
      cwd: normalizeSnapshotPath(snapshot.workspace.cwd, type),
    },
    permissionPreset: snapshot.permissionPreset,
    effectiveWriteScope: snapshot.effectiveWriteScope,
    sandbox: {
      tier: snapshot.sandbox.tier,
      measured: snapshot.sandbox.measured,
      boundaryActive: snapshot.sandbox.boundaryActive,
      mechanism: snapshot.sandbox.mechanism,
    },
  });
}

/** 稳定 boundaryId:身份摘要前 12 位十六进制,加 `b` 前缀避免与工具 id 视觉混淆。 */
export function boundaryIdFor(snapshot: ToolBoundarySnapshot): string {
  return `b${createHash("sha256").update(boundaryIdentityKey(snapshot)).digest("hex").slice(0, 12)}`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function presetField(value: unknown): WorkspacePermissionPreset | null {
  return value === "confirm_each" || value === "balanced" || value === "full_access" ? value : null;
}

function writeScopeField(value: unknown): ToolBoundaryWriteScope | null {
  return value === "strict" || value === "wide" ? value : null;
}

function sandboxTierField(value: unknown): ToolBoundarySandboxTier | null {
  return value === "off" || value === "restricted" || value === "full" ? value : null;
}

function sandboxMeasurementField(value: unknown): ToolBoundarySandboxMeasurement | null {
  return value === "enforced" || value === "not_enforced" || value === "unknown" ? value : null;
}

function sandboxMechanismField(value: unknown): ToolBoundarySandboxMechanism | null {
  return value === "windows_integrity" || value === "container_mounts" || value === "none" ? value : null;
}

/** 从 boundary 事件 payload(扁平:boundaryId + 快照字段)解析快照;形状不符返回 null,
 *  投影侧跳过而不是把坏数据当成"无边界"。 */
export function parseBoundarySnapshot(value: unknown): ToolBoundarySnapshot | null {
  if (!isRecordValue(value)) return null;
  const workspace = value.workspace;
  const sandbox = value.sandbox;
  if (!isRecordValue(workspace) || !isRecordValue(sandbox)) return null;
  const id = stringField(workspace.id);
  const type = workspace.type === "local" || workspace.type === "ssh" ? workspace.type : null;
  const root = stringField(workspace.root);
  const cwd = stringField(workspace.cwd);
  const permissionPreset = presetField(value.permissionPreset);
  const effectiveWriteScope = writeScopeField(value.effectiveWriteScope);
  const tier = sandboxTierField(sandbox.tier);
  const measured = sandboxMeasurementField(sandbox.measured);
  const boundaryActive = typeof sandbox.boundaryActive === "boolean" ? sandbox.boundaryActive : null;
  const mechanism = sandboxMechanismField(sandbox.mechanism);
  const checkedAt = typeof sandbox.checkedAt === "number" && Number.isFinite(sandbox.checkedAt) ? sandbox.checkedAt : null;
  if (
    id === null ||
    type === null ||
    root === null ||
    cwd === null ||
    permissionPreset === null ||
    effectiveWriteScope === null ||
    tier === null ||
    measured === null ||
    boundaryActive === null ||
    mechanism === null ||
    checkedAt === null
  ) {
    return null;
  }
  return {
    workspace: { id, type, root, cwd },
    permissionPreset,
    effectiveWriteScope,
    sandbox: { tier, measured, boundaryActive, mechanism, checkedAt },
  };
}
