/**
 * 定时任务卡片的操作菜单：立即运行 / 重启 / 暂停恢复 / 编辑 / 删除。
 */
import { RotateCcw } from "lucide-react";
import type { ZCodeAutomation } from "@zcode/shared";
import {
  TID_AUTOMATION_ACTION_DELETE,
  TID_AUTOMATION_ACTION_TOGGLE,
  TID_AUTOMATION_CARD_MENU,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

interface AutomationActionsMenuProps {
  automation: ZCodeAutomation;
  busy: boolean;
  canRestart: boolean;
  canToggle: boolean;
  onRunNow: (automation: ZCodeAutomation) => void;
  onEdit: (automation: ZCodeAutomation) => void;
  onToggle: (automation: ZCodeAutomation, enabled: boolean) => void;
  onRestart: (automation: ZCodeAutomation) => void;
  onDelete: (automation: ZCodeAutomation) => void;
}

export function AutomationActionsMenu({
  automation,
  busy,
  canRestart,
  canToggle,
  onRunNow,
  onEdit,
  onToggle,
  onRestart,
  onDelete,
}: AutomationActionsMenuProps) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-hover md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
          data-testid={TID_AUTOMATION_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          disabled={busy}
          // 卡片可点进编辑;菜单点击不冒泡到卡片。
          onClick={(event) => event.stopPropagation()}
        >
          <AutomationMoreHorizontalIcon
            className="size-4 text-foreground-subtle"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-[190px]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 立即运行：当前 RPC 期间用 busy 防重，返回后恢复入口；活动 run 由 host single-flight 判重。 */}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onRunNow(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.runNow" })}
        </DropdownMenuItem>
        {canRestart ? (
          <DropdownMenuItem
            className="gap-1"
            disabled={busy}
            onSelect={() => void onRestart(automation)}
          >
            <span className="flex size-5 items-center justify-center">
              <RotateCcw className="size-4" strokeWidth={1.33} aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "automations.restart" })}
          </DropdownMenuItem>
        ) : null}
        {/* 终态任务不展示 pause/resume：failed 可 Restart，completed 彻底收口只保留查看/删除。 */}
        {canToggle ? (
          <DropdownMenuItem
            data-testid={TID_AUTOMATION_ACTION_TOGGLE}
            className="gap-1"
            disabled={busy}
            onSelect={() => void onToggle(automation, !automation.enabled)}
          >
            {automation.enabled ? (
              <span className="flex size-5 items-center justify-center">
                <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <span className="flex size-5 items-center justify-center">
                <AutomationContinueIcon className="size-4" aria-hidden="true" />
              </span>
            )}
            {intl.formatMessage({
              id: automation.enabled ? "automations.pause" : "automations.resume",
            })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          onSelect={() => void onEdit(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationEditActionIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.form.editTitle" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={TID_AUTOMATION_ACTION_DELETE}
          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
          disabled={busy}
          onSelect={() => void onDelete(automation)}
        >
          <AutomationTrashIcon />
          {intl.formatMessage({ id: "automations.delete" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
