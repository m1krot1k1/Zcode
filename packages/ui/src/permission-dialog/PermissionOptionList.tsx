import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { PermissionRequestScope } from "@/lib/permissionRequest.js";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getPermissionOptionDisplayKind,
  shouldPreferPermissionOptionName,
} from "@/lib/permissionRequest.js";
import { workflowAdjustedOptionDescriptionId } from "@/permissionWorkflowSettings.js";
import {
  getOptionDescriptionMessageId,
  getOptionLabelMessageId,
  getProviderOptionNameMessageIds,
  isOfficialCuaProjectPermission,
  readPermissionRuleScopes,
  type PermissionRuleScope,
} from "./permissionDialogModel.js";

interface InlinePermissionPrefixScopesProps {
  scopes: readonly PermissionRuleScope[];
}

function InlinePermissionPrefixScopes({ scopes }: InlinePermissionPrefixScopesProps) {
  if (scopes.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-1 basis-48 flex-col gap-1"
      data-permission-rule-scopes="true"
      data-permission-rule-prefixes="true"
    >
      {scopes.map((scope, index) => (
        <code
          key={`${scope.display}:${index}`}
          className="min-w-0 whitespace-pre-wrap break-all font-mono text-ui-base leading-5 text-foreground-subtle"
          data-permission-rule-scope="prefix"
          data-permission-rule-scope-truncated={scope.truncated ? "true" : undefined}
        >
          {scope.display}
        </code>
      ))}
    </span>
  );
}

export interface PermissionOptionListProps {
  options: readonly ZCodePermissionOption[];
  selectedIndex: number;
  provider?: ZCodeProvider;
  scope: PermissionRequestScope;
  workflowSettingsContent: WorkflowAskSettingsContent | undefined;
  isOptionBlocked: (option: ZCodePermissionOption) => boolean;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  onSelectIndex: (index: number) => void;
  onActivateOption: (option: ZCodePermissionOption) => void;
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * 权限选项列表。文案解析留在这一层：label/description 的优先级是产品规则
 * （协议 name 优先于 kind 本地化、workflow 改过设置后改口），和选项按钮结构一起变动。
 */
export function PermissionOptionList({
  options,
  selectedIndex,
  provider,
  scope,
  workflowSettingsContent,
  isOptionBlocked,
  optionRefs,
  onSelectIndex,
  onActivateOption,
  onOptionKeyDown,
}: PermissionOptionListProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      role="listbox"
      aria-label={intl.formatMessage({ id: "chat.permission.title" })}
      className="space-y-1"
    >
      {options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const officialCuaProjectPermission = isOfficialCuaProjectPermission(option);
        const labelMessageId = officialCuaProjectPermission
          ? "chat.permission.cua.allowForProject"
          : option.name.trim().toLowerCase() === "always allow in this project" &&
              scope === "command"
            ? "chat.permission.allowCommand"
            : getOptionLabelMessageId(option.kind);
        const nameMessageIds = getProviderOptionNameMessageIds(provider, option.name);
        const baseDescriptionMessageId = officialCuaProjectPermission
          ? "chat.permission.cua.allowForProject.description"
          : labelMessageId === "chat.permission.allowCommand"
            ? "chat.permission.allowCommand.description"
            : (nameMessageIds?.description ?? getOptionDescriptionMessageId(option.kind, scope));
        // 工作流确认窗改过设置：放行的两项改口说「按调整后的设置」（docs/dynamic-workflow/launch.md
        // 「The options」）。
        const descriptionMessageId =
          workflowSettingsContent === undefined
            ? baseDescriptionMessageId
            : workflowAdjustedOptionDescriptionId(baseDescriptionMessageId);
        const blocked = isOptionBlocked(option);
        const fallbackLabel = labelMessageId ? intl.formatMessage({ id: labelMessageId }) : null;
        const knownNameLabel = nameMessageIds
          ? intl.formatMessage({ id: nameMessageIds.label })
          : null;
        // ZCode Agent 协议里 option.name 才是给用户看的真实选项文案，kind 只表示按钮语义。
        // 之前这里一律按 kind 本地化，像 switch_mode 这类不同语义但同属 allow_always 的选项，
        // 会被错误压成两条一模一样的“始终允许”。
        const preferOptionName = shouldPreferPermissionOptionName(option);
        const label =
          (labelMessageId === "chat.permission.allowCommand" ? fallbackLabel : knownNameLabel) ??
          (preferOptionName ? option.name : (fallbackLabel ?? option.name));
        const description =
          (preferOptionName && !knownNameLabel) || !descriptionMessageId
            ? null
            : intl.formatMessage({ id: descriptionMessageId });
        const ruleScopes =
          getPermissionOptionDisplayKind(option.kind) === "allowAlways"
            ? readPermissionRuleScopes(option)
            : [];

        return (
          <button
            key={option.optionId}
            // exact rule 按产品语义不展示后，E2E 不能再靠可见规则文本猜 option；
            // 暴露规范化语义供无障碍自动化稳定选择，不泄露原始命令内容。
            data-permission-option-kind={getPermissionOptionDisplayKind(option.kind)}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            role="option"
            aria-label={label}
            aria-selected={isSelected}
            {...(blocked ? { "aria-disabled": true } : {})}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => {
              if (isSelected) {
                onActivateOption(option);
              } else {
                onSelectIndex(index);
              }
            }}
            onFocus={() => onSelectIndex(index)}
            onKeyDown={onOptionKeyDown}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected",
              isSelected ? "bg-selected" : "hover:bg-hover",
              blocked && "cursor-not-allowed opacity-50",
            )}
          >
            <span
              className={cn(
                "w-5 shrink-0 text-ui-base font-medium self-center",
                isSelected ? "text-foreground" : "text-foreground-subtlest",
              )}
            >
              {index + 1}.
            </span>
            <span className="min-w-0 flex flex-1 flex-col">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-ui-base font-medium text-foreground">{label}</span>
                {ruleScopes.length > 0 ? (
                  <InlinePermissionPrefixScopes scopes={ruleScopes} />
                ) : description ? (
                  <span className="text-ui-base leading-4 text-foreground-subtle">
                    {description}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
