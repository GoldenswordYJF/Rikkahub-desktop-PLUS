import * as React from "react";

import { cn } from "~/lib/utils";
import { CompanionSprite } from "./companion-sprite";
import { COMPANION_SKINS } from "./pixel-sprites";

export type CompanionMood =
  | "idle"
  | "working"
  | "compacting"
  | "attention"
  | "happy"
  | "sleeping"
  | "error";

/** 唯一在架伴侣。帕秋莉已下线,但设置字段保留:旧数据里的残留 id 一律兜到这里。 */
export type CompanionSkinId = "deepy";

export const DEFAULT_COMPANION_SKIN: CompanionSkinId = "deepy";

/** 像素图只能整倍放大,所以「大小」是档位而不是滑杆:1=小巧 2=标准 3=大 4=特大。 */
export const COMPANION_SCALES = [1, 2, 3, 4] as const;
export type CompanionScale = (typeof COMPANION_SCALES)[number];

/** 兜住手改设置/旧数据里的非法值,渲染层永远拿到合法档位。 */
export function normalizeCompanionScale(value: unknown): CompanionScale {
  const rounded = Math.round(Number(value));
  return COMPANION_SCALES.includes(rounded as CompanionScale)
    ? (rounded as CompanionScale)
    : 2;
}

/** 同上,管皮肤:只认还在架的 id,其余(含已删除的 patchouli)兜回默认那只。 */
export function normalizeCompanionSkin(value: unknown): CompanionSkinId {
  return COMPANION_SKINS[value as CompanionSkinId]
    ? (value as CompanionSkinId)
    : DEFAULT_COMPANION_SKIN;
}

export function companionPixelSize(skinId: CompanionSkinId, scale: CompanionScale) {
  const skin = COMPANION_SKINS[skinId] ?? COMPANION_SKINS[DEFAULT_COMPANION_SKIN];
  return { width: skin.width * scale, height: skin.height * scale };
}

/** 情绪 → 皮肤动画键。每只皮肤各有专帧,缺键时渲染层回落到 idle。 */
const SKIN_ANIMS: Record<CompanionSkinId, Record<CompanionMood, string>> = {
  deepy: {
    idle: "idle",
    working: "typing",
    compacting: "compacting",
    attention: "notification",
    happy: "happy",
    sleeping: "sleeping",
    error: "error",
  },
};

export interface CompanionViewProps {
  skinId: CompanionSkinId;
  mood: CompanionMood;
  scale: CompanionScale;
  ariaLabel: string;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerMove?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerEnd?: React.PointerEventHandler<HTMLButtonElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  dragging: boolean;
  onPoke: () => void;
}

/** 宠物本体 + 状态装饰(zzz/「!」)。尺寸由皮肤像素 × 整数倍缩放得出,气泡由外层 Dock 定位。 */
export function CompanionView({
  skinId,
  mood,
  scale,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onKeyDown,
  dragging,
  onPoke,
}: CompanionViewProps) {
  // 设置里可能还留着已下线的 id,在这里兜一次,后面查表就不用再防一层。
  const activeSkin = normalizeCompanionSkin(skinId);
  const skin = COMPANION_SKINS[activeSkin];
  const animation = SKIN_ANIMS[activeSkin][mood];
  const size = companionPixelSize(activeSkin, scale);

  return (
    <div
      className="companion-view"
      style={{
        width: size.width,
        height: size.height,
        // zzz / 「!」按精灵尺寸等比走,否则大号伴侣配 10px 的 z 会像贴了张便签。
        ["--companion-scale" as string]: String(scale),
      }}
    >
      <button
        type="button"
        className={cn("companion-pet", dragging && "is-dragging")}
        aria-label={ariaLabel}
        onClick={onPoke}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <span
          className={cn(
            "companion-pet-body",
            mood === "happy" && "is-happy",
            mood === "sleeping" && "is-sleeping",
          )}
        >
          <CompanionSprite skin={skin} animation={animation} scale={scale} />
        </span>
        {mood === "sleeping" ? (
          <span className="companion-zzz" aria-hidden="true">
            z z
          </span>
        ) : null}
        {mood === "attention" ? (
          <span className="companion-alert" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>
    </div>
  );
}
