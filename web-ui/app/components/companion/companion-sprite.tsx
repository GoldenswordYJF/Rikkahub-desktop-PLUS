import * as React from "react";

import { cn } from "~/lib/utils";
import type { CompanionSkin } from "./pixel-sprites";

/** 系统「减少动态效果」偏好:变化时实时响应(帧动画整体退化为首帧)。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface CompanionSpriteProps {
  skin: CompanionSkin;
  /** 动画键(idle/typing/...),缺省或未知时退回 idle。 */
  animation: string;
  /** 每个逻辑像素画成 scale × scale 个 CSS 像素(整数,避免像素缝)。 */
  scale?: number;
  className?: string;
}

/**
 * 调色板字符画 → canvas。帧数据是模块级常量(见 pixel-sprites.ts),这里只做
 * 按 `dur` 累计取帧的确定性播放:同一时刻的帧只取决于 elapsed,不依赖播放历史,
 * 标签页恢复/重挂载时不会跳帧。只有一帧的动画不启动 rAF。
 */
export function CompanionSprite({
  skin,
  animation,
  scale = 2,
  className,
}: CompanionSpriteProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const frames = skin.anims[animation] ?? skin.anims.idle ?? Object.values(skin.anims)[0] ?? [];

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 逻辑像素落整数 CSS 像素,再按 DPR 放大物理分辨率——像素画不允许半像素模糊。
    const dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
    const cssWidth = skin.width * scale;
    const cssHeight = skin.height * scale;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = (index: number) => {
      const frame = frames[index % frames.length];
      const pixels = frame?.pixels ?? "";
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      for (let y = 0; y < skin.height; y += 1) {
        const row = y * skin.width;
        for (let x = 0; x < skin.width; x += 1) {
          const ch = pixels[row + x];
          if (!ch || ch === ".") continue;
          const color = skin.palette[ch];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    };

    if (reducedMotion || frames.length === 1) {
      draw(0);
      return;
    }

    const total = frames.reduce((sum, frame) => sum + Math.max(1, frame.dur), 0);
    const startedAt = performance.now();
    let raf = 0;
    let lastIndex = -1;
    const tick = (now: number) => {
      let elapsed = (now - startedAt) % total;
      let index = frames.length - 1;
      for (let i = 0; i < frames.length; i += 1) {
        elapsed -= Math.max(1, frames[i]?.dur ?? 1);
        if (elapsed < 0) {
          index = i;
          break;
        }
      }
      // 每帧都在 rAF 里重画会白白烧 60 次/秒的整块 fillRect;同一帧内容只画一次。
      if (index !== lastIndex) {
        lastIndex = index;
        draw(index);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [skin, frames, scale, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      width={skin.width * scale}
      height={skin.height * scale}
      className={cn("companion-canvas", className)}
      aria-hidden="true"
    />
  );
}
