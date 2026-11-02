import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConversationEngineStatus } from "~/stores/conversation-store";
import { useSettingsStore } from "~/stores";
import { patchDisplay } from "~/lib/settings-patch";
import {
  CompanionView,
  companionPixelSize,
  normalizeCompanionScale,
  normalizeCompanionSkin,
  type CompanionMood,
} from "./companion-view";

// 情绪时长:互动后的开心跳、无操作后的犯困、气泡停留。气泡走 setTimeout 自动收,
// 不依赖外部状态,避免"确认完还挂着旧提醒"。
const HAPPY_MS = 1_800;
const SLEEP_AFTER_MS = 90_000;
const BUBBLE_MS = 4_200;
const POKE_LINES = 4;
// 拖拽:超过这个位移才算"拖",否则手抖一下就把戳一戳吞了。
const DRAG_THRESHOLD_PX = 4;
// 键盘微调:方向键一格 12px,按住 Shift 加大到 36px。
const KEY_STEP_PX = 12;
// 贴边留的余量:宠物整体不许跑出会话窗格(左侧栏/输入区不是它的活动范围)。
const EDGE_INSET_PX = 6;

interface CompanionPos {
  x: number;
  y: number;
}

/** 指针按下时抓的快照:之后的每一次位移都相对它算,避免中途设置回推把基准挪走。 */
interface DragBase {
  pointerId: number;
  startX: number;
  startY: number;
  pos: CompanionPos;
  /** 当前 Dock 的视口矩形(已含既有位移)。 */
  rect: DOMRect;
  /** 会话窗格矩形;取不到就完全不夹,允许用户拖到窗口外再拖回来。 */
  bounds: DOMRect | null;
  moved: boolean;
}

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function readPos(value: unknown): CompanionPos {
  const raw = value as Partial<CompanionPos> | null | undefined;
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

export interface DesktopCompanionProps {
  conversationId: string | null;
  isGenerating: boolean;
}

/**
 * 实验性桌面伴侣:挂在对话输入区附近的像素宠物(窗格够宽才出现,见 app.css 的
 * `.companion-dock` 容器查询)。默认锚点在输入列左下,可以拖到窗格内任意位置,
 * 落点写进 displaySetting.companionPos;大小是整数档位 companionScale。
 * 自身不发起任何请求,情绪完全由本会话的瞬态状态推导:
 * 审批等待 > 压缩 > 生成 > 互动/完成 > 久置困倦 > 发呆。
 */
export function DesktopCompanion({ conversationId, isGenerating }: DesktopCompanionProps) {
  const { t } = useTranslation("input");
  const enabled = useSettingsStore((state) => state.settings?.displaySetting.showCompanion ?? false);
  const skinSetting = useSettingsStore((state) => state.settings?.displaySetting.companionSkin);
  const bubblesEnabled = useSettingsStore(
    (state) => state.settings?.displaySetting.companionBubbles ?? true,
  );
  const scaleSetting = useSettingsStore((state) => state.settings?.displaySetting.companionScale);
  const posSetting = useSettingsStore((state) => state.settings?.displaySetting.companionPos);
  const skinId = normalizeCompanionSkin(skinSetting);
  const scale = normalizeCompanionScale(scaleSetting ?? 2);
  const status = useConversationEngineStatus(conversationId);

  const [happyUntil, setHappyUntil] = React.useState(0);
  const [sleepy, setSleepy] = React.useState(false);
  const [wakeTick, setWakeTick] = React.useState(0);
  const [pokeCount, setPokeCount] = React.useState(0);
  const [bubble, setBubble] = React.useState<{ id: number; text: string } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [livePos, setLivePos] = React.useState<CompanionPos | null>(null);
  const bubbleSeq = React.useRef(0);
  const lastActivityRef = React.useRef(Date.now());
  const prevPhaseRef = React.useRef<string | null>(null);
  const prevGeneratingRef = React.useRef(false);
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<DragBase | null>(null);
  /** 拖完松手会补一个 click,靠它把这次戳一戳吞掉(否则挪个位置宠物就说话了)。 */
  const suppressClickRef = React.useRef(false);

  const phase = status?.phase ?? null;
  const busy = phase !== null || isGenerating;
  const persistedPos = React.useMemo(() => readPos(posSetting), [posSetting]);

  const say = React.useCallback(
    (key: string) => {
      if (!bubblesEnabled) return;
      bubbleSeq.current += 1;
      setBubble({ id: bubbleSeq.current, text: t(`companion.${skinId}.${key}`) });
    },
    [bubblesEnabled, skinId, t],
  );

  const wake = React.useCallback(() => {
    lastActivityRef.current = Date.now();
    setSleepy(false);
    setWakeTick((n) => n + 1);
  }, []);

  /** 位移夹进会话窗格:回推未位移的原点,再算这个方向上允许的最小/最大增量。 */
  const clampToPane = React.useCallback((next: CompanionPos, base: DragBase): CompanionPos => {
    if (!base.bounds) return next;
    const originLeft = base.rect.left - base.pos.x;
    const originTop = base.rect.top - base.pos.y;
    const range = (min: number, max: number) => [Math.min(min, max), Math.max(min, max)] as const;
    const [xLo, xHi] = range(
      base.bounds.left + EDGE_INSET_PX - originLeft,
      base.bounds.right - EDGE_INSET_PX - base.rect.width - originLeft,
    );
    const [yLo, yHi] = range(
      base.bounds.top + EDGE_INSET_PX - originTop,
      base.bounds.bottom - EDGE_INSET_PX - base.rect.height - originTop,
    );
    return { x: clampNumber(next.x, xLo, xHi), y: clampNumber(next.y, yLo, yHi) };
  }, []);

  const paneBounds = (dock: HTMLDivElement): DOMRect | null =>
    dock.closest<HTMLElement>(".chat-pane")?.getBoundingClientRect() ?? null;

  /** 以当前渲染状态抓一份测量基准(display:none 时量到的是 0,不能拿来夹)。 */
  const measureBase = (pos: CompanionPos): DragBase | null => {
    const dock = dockRef.current;
    if (!dock) return null;
    const rect = dock.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      pointerId: -1,
      startX: 0,
      startY: 0,
      pos,
      rect,
      bounds: paneBounds(dock),
      moved: false,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const dock = dockRef.current;
    if (!dock) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pos: persistedPos,
      rect: dock.getBoundingClientRect(),
      bounds: paneBounds(dock),
      moved: false,
    };
    // 捕获后指针滑出宠物甚至滑出窗口,move/up 仍然回到这里,不会出现"松手还在拖"。
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const base = dragRef.current;
    if (!base || base.pointerId !== event.pointerId) return;
    const dx = event.clientX - base.startX;
    const dy = event.clientY - base.startY;
    if (!base.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!base.moved) {
      base.moved = true;
      setDragging(true);
    }
    setLivePos(clampToPane({ x: base.pos.x + dx, y: base.pos.y + dy }, base));
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const base = dragRef.current;
    if (!base || base.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setLivePos(null);
    if (!base.moved) return;
    suppressClickRef.current = true;
    const dx = event.clientX - base.startX;
    const dy = event.clientY - base.startY;
    const final = clampToPane({ x: base.pos.x + dx, y: base.pos.y + dy }, base);
    patchDisplay({ companionPos: { x: Math.round(final.x), y: Math.round(final.y) } });
    wake();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? KEY_STEP_PX * 3 : KEY_STEP_PX;
    const move: Record<string, CompanionPos> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = move[event.key];
    if (!delta) return;
    event.preventDefault();
    const base = measureBase(persistedPos);
    if (!base) return;
    const next = clampToPane({ x: persistedPos.x + delta.x, y: persistedPos.y + delta.y }, base);
    patchDisplay({ companionPos: { x: Math.round(next.x), y: Math.round(next.y) } });
    wake();
  };

  // 窗格变窄/变宽、换档位之后,原本合法的位移可能已经出界;就地夹回可视范围。
  // 观察的是窗格而不是 window.resize:分屏、左侧栏开合都只改窗格宽度,不发生窗口缩放。
  // 拖拽进行中不夹(用户正把手势指向那个方向),量不到尺寸时也不夹(display:none 时矩形为 0)。
  React.useEffect(() => {
    if (!enabled) return;
    const reclamp = () => {
      if (dragRef.current) return;
      const base = measureBase(persistedPos);
      if (!base) return;
      const next = clampToPane(persistedPos, base);
      if (Math.round(next.x) !== persistedPos.x || Math.round(next.y) !== persistedPos.y) {
        patchDisplay({ companionPos: { x: Math.round(next.x), y: Math.round(next.y) } });
      }
    };
    reclamp();
    const pane = dockRef.current?.closest<HTMLElement>(".chat-pane") ?? null;
    if (!pane || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", reclamp);
      return () => window.removeEventListener("resize", reclamp);
    }
    const observer = new ResizeObserver(reclamp);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [enabled, persistedPos, skinId, scale, clampToPane]);

  // 引擎相位跳变:审批等待 / 压缩开始时各冒一句(气泡内容随皮肤走)。
  React.useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (!enabled) return;
    lastActivityRef.current = Date.now();
    setSleepy(false);
    if (phase === "awaiting_approval" && prev !== "awaiting_approval") {
      say("attention");
    } else if (phase === "compacting" && prev !== "compacting") {
      say("compacting");
    }
  }, [phase, enabled, say]);

  // 生成结束:开心跳一下(不弹气泡——每轮都冒话会吵;有待确认时走上面的审批提醒)。
  React.useEffect(() => {
    const was = prevGeneratingRef.current;
    prevGeneratingRef.current = isGenerating;
    if (!enabled) return;
    if (was && !isGenerating) {
      setHappyUntil(Date.now() + HAPPY_MS);
      lastActivityRef.current = Date.now();
    }
  }, [isGenerating, enabled]);

  // 开心/犯困的计时器:状态一过就回落,不做常驻轮询。
  React.useEffect(() => {
    if (happyUntil === 0) return;
    const remaining = happyUntil - Date.now();
    if (remaining <= 0) {
      setHappyUntil(0);
      return;
    }
    const timer = window.setTimeout(() => setHappyUntil(0), remaining);
    return () => window.clearTimeout(timer);
  }, [happyUntil]);

  React.useEffect(() => {
    if (!enabled) return;
    if (busy) {
      setSleepy(false);
      return;
    }
    const timer = window.setTimeout(() => setSleepy(true), SLEEP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy, enabled, wakeTick]);

  React.useEffect(() => {
    if (!bubble) return;
    const timer = window.setTimeout(() => setBubble(null), BUBBLE_MS);
    return () => window.clearTimeout(timer);
  }, [bubble]);

  // 设置页刚关掉气泡时,不等 4.2s 计时自然结束,立刻收掉当前那条。
  React.useEffect(() => {
    if (!bubblesEnabled) setBubble(null);
  }, [bubblesEnabled]);

  if (!enabled) return null;

  const mood: CompanionMood =
    phase === "awaiting_approval"
      ? "attention"
      : phase === "compacting"
        ? "compacting"
        : phase !== null || isGenerating
          ? "working"
          : Date.now() < happyUntil
            ? "happy"
            : sleepy
              ? "sleeping"
              : "idle";

  const name = t(`companion.${skinId}.name`);
  const handlePoke = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    wake();
    setHappyUntil(Date.now() + HAPPY_MS);
    say(`poke_${(pokeCount % POKE_LINES) + 1}`);
    setPokeCount((n) => n + 1);
  };

  const size = companionPixelSize(skinId, scale);
  const shownPos = livePos ?? persistedPos;

  return (
    <div
      ref={dockRef}
      className="companion-dock"
      data-companion-scale={scale}
      style={{
        width: size.width,
        height: size.height,
        transform: `translate3d(${shownPos.x}px, ${shownPos.y}px, 0)`,
      }}
    >
      {bubble ? (
        <div key={bubble.id} className="companion-bubble" aria-hidden="true">
          {bubble.text}
        </div>
      ) : null}
      <CompanionView
        skinId={skinId}
        mood={mood}
        scale={scale}
        dragging={dragging}
        ariaLabel={t("companion.aria", { name })}
        onPoke={handlePoke}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerEnd={handlePointerEnd}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
