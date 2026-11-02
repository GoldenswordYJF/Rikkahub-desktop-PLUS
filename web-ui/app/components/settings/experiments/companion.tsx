// 设置 › 实验功能 › 桌面伴侣。
// 定位:纯装饰的输入区像素宠物。设置只落 displaySetting 五个字段(总开关/皮肤/气泡/
// 大小档位/落点位移),保存走 patchDisplay 的字段级浅合并——不整份回发 settings,
// 避免与其他显示设置互相覆盖。
import { useTranslation } from "react-i18next";
import { FlaskConical, RotateCcw } from "lucide-react";

import { CompanionSprite } from "~/components/companion/companion-sprite";
import { COMPANION_SKINS } from "~/components/companion/pixel-sprites";
import {
  COMPANION_SCALES,
  companionPixelSize,
  normalizeCompanionScale,
  normalizeCompanionSkin,
  type CompanionScale,
  type CompanionSkinId,
} from "~/components/companion/companion-view";
import type { SettingsSectionProps } from "~/components/settings/settings-registry";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { patchDisplay } from "~/lib/settings-patch";
import { cn } from "~/lib/utils";

/** 档位读数:1=小巧 2=标准 3=大 4=特大。标签按档位复用,避免同一句说明写四遍。 */
const SCALE_LABEL_KEYS: Record<CompanionScale, string> = {
  1: "small",
  2: "normal",
  3: "large",
  4: "giant",
};

function SkinOption({
  skinId,
  label,
  description,
  active,
  disabled,
  onSelect,
}: {
  skinId: CompanionSkinId;
  label: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center gap-2 rounded-[var(--ds-radius-md)] border px-3 py-4 text-center transition-colors",
        active
          ? "border-[var(--ds-brand-primary)] bg-[var(--ds-on-surface-active)]"
          : "border-[var(--ds-divider)] hover:bg-[var(--ds-on-surface)]",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="grid h-20 w-20 place-items-center">
        <CompanionSprite skin={COMPANION_SKINS[skinId]} animation="idle" scale={2} />
      </span>
      <span data-settings-label="" className="text-sm font-medium text-[var(--ds-text-primary)]">
        {label}
      </span>
      <span className="text-xs leading-relaxed text-[var(--ds-text-secondary)]">{description}</span>
    </button>
  );
}

export function CompanionExperimentSection({ settings }: SettingsSectionProps) {
  const { t } = useTranslation();
  const current = settings.displaySetting;
  const enabled = current.showCompanion ?? false;
  const bubbles = current.companionBubbles ?? true;
  const skin = normalizeCompanionSkin(current.companionSkin);
  const scale = normalizeCompanionScale(current.companionScale ?? 2);
  const pos = current.companionPos ?? { x: 0, y: 0 };
  const atDefaultSpot = Math.round(pos.x) === 0 && Math.round(pos.y) === 0;
  // 说明里报当前像素尺寸,让用户知道「大」到底大多少(尺寸随皮肤网格与档位变)。
  const preview = companionPixelSize(skin, scale);

  return (
    <SettingsStack>
      <div className="flex gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-text-tertiary)]" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-[var(--ds-text-primary)]">
            {t("settings:experiments.companion.notice_title")}
          </p>
          <p className="text-xs text-[var(--ds-text-secondary)]">
            {t("settings:experiments.companion.notice_desc")}
          </p>
        </div>
      </div>

      <SettingsGroup
        title={t("settings:experiments.companion.master_title")}
        description={t("settings:experiments.companion.master_desc")}
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.companion.enable")}
            description={t("settings:experiments.companion.enable_desc")}
            checked={enabled}
            onCheckedChange={(checked) => patchDisplay({ showCompanion: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.companion.bubbles")}
            description={t("settings:experiments.companion.bubbles_desc")}
            checked={bubbles}
            disabled={!enabled}
            onCheckedChange={(checked) => patchDisplay({ companionBubbles: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:experiments.companion.skin_title")}
        description={t("settings:experiments.companion.skin_desc")}
        fields
      >
        <div className="grid gap-3 sm:max-w-sm">
          <SkinOption
            skinId="deepy"
            label={t("settings:experiments.companion.skin_deepy")}
            description={t("settings:experiments.companion.skin_deepy_desc")}
            active={skin === "deepy"}
            disabled={!enabled}
            onSelect={() => patchDisplay({ companionSkin: "deepy" })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:experiments.companion.size_title")}
        description={t("settings:experiments.companion.size_desc", {
          width: preview.width,
          height: preview.height,
        })}
      >
        <SettingsRows>
          <SettingsRow
            label={t("settings:experiments.companion.size_row")}
            description={t("settings:experiments.companion.size_row_desc")}
            control={
              <div
                role="radiogroup"
                aria-label={t("settings:experiments.companion.size_row")}
                className="flex rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] p-0.5"
              >
                {COMPANION_SCALES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={scale === option}
                    disabled={!enabled}
                    onClick={() => patchDisplay({ companionScale: option })}
                    className={cn(
                      "rounded-[calc(var(--ds-radius-md)-2px)] px-3 py-1 text-xs transition-colors",
                      scale === option
                        ? "bg-[var(--ds-on-surface-active)] font-medium text-[var(--ds-text-primary)]"
                        : "text-[var(--ds-text-secondary)] hover:bg-[var(--ds-on-surface)]",
                      !enabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {t(`settings:experiments.companion.size_${SCALE_LABEL_KEYS[option]}`)}
                  </button>
                ))}
              </div>
            }
          />
          <SettingsRow
            label={t("settings:experiments.companion.pos_title")}
            description={t("settings:experiments.companion.pos_desc")}
            control={
              <Button
                type="button"
                variant="tertiary"
                size="xs"
                disabled={!enabled || atDefaultSpot}
                onClick={() => patchDisplay({ companionPos: { x: 0, y: 0 } })}
              >
                <RotateCcw aria-hidden />
                {t("settings:experiments.companion.pos_reset")}
              </Button>
            }
          />
        </SettingsRows>
      </SettingsGroup>
    </SettingsStack>
  );
}
