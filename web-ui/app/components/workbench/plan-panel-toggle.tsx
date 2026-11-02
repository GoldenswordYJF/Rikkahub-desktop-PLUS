import * as React from "react";
import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useConversationStore } from "~/stores/conversation-store";
import { getLatestPlan } from "~/lib/plan-model";
import { planProgress } from "@server/tools/plan";
import { cn } from "~/lib/utils";

import { useWorkbench } from "./workbench-context";

// 计划面板的顶栏入口:只有当本会话真的存在一份计划时才出现,平时不占标签行。
// 不额外拿 displaySetting.planPanel 把门——开关关掉只是不再向模型声明这个工具,
// 历史里已经写下的计划仍然读得到,没道理因为开关关了就把用户已有的信息藏起来。
export function PlanPanelToggle({ conversationId }: { conversationId?: string | null }) {
  const { t } = useTranslation();
  const { panel, openPanel, closePanel } = useWorkbench();
  const detail = useConversationStore((state) =>
    conversationId ? state.entries[conversationId]?.detail : undefined,
  );
  const plan = React.useMemo(() => getLatestPlan(detail ?? null), [detail]);

  if (!plan) return null;
  const progress = planProgress(plan);
  const isOpen = panel?.type === "plan";
  const label = isOpen
    ? t("workbench.plan.toggle_close")
    : t("workbench.plan.toggle_open");

  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={isOpen}
      className={cn(
        "pointer-events-auto relative z-50 mb-1 h-7 shrink-0 gap-1 rounded-md px-1.5",
        "text-muted-foreground hover:text-foreground",
        isOpen && "text-foreground",
      )}
      onClick={() => {
        if (isOpen) {
          closePanel();
          return;
        }
        openPanel({
          type: "plan",
          title: plan.title || t("workbench.plan.title"),
          payload: conversationId ? { conversationId } : {},
        });
      }}
    >
      <ListChecks className="size-4" strokeWidth={1.75} />
      <span className="text-[11px] leading-none tabular-nums">
        {progress.completed}/{progress.total}
      </span>
    </Button>
  );
}
