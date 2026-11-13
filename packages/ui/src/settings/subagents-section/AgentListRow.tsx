import type { AgentSummary } from "@zcode/shared";
import { TID_SUBAGENT_ROW, testId } from "@zcode/shared/test-ids";
import type { ModelSelectionView } from "@zcode/services";
import { Bot, Trash2 } from "lucide-react";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { AgentBadge, AgentColorDot } from "@/settings/subagents-section/SubagentPrimitives.js";
import { SubagentModelOverrideControl } from "@/settings/subagents-section/SubagentModelOverrideControl.js";
import {
  isEditableUserAgent,
  supportsEnabledToggle,
  supportsModelOverride,
} from "@/settings/subagents-section/subagentAgentProjection.js";
import {
  allowsAllTools,
  resolveSubagentModelLabel,
  toSubagentModelValue,
} from "@/settings/subagents-section/subagentModel.js";

export function AgentListRow({
  agent,
  pluginIconItem,
  isOperating,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  modelSelectGroups,
  onModelOverrideChange,
  onDelete,
  onEdit,
  onToggle,
}: {
  agent: AgentSummary;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  isOperating: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
  onDelete: (agent: AgentSummary) => void;
  onEdit: (agent: AgentSummary) => void;
  onToggle: (agent: AgentSummary, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const editable = isEditableUserAgent(agent);
  const showEnabledToggle = supportsEnabledToggle(agent);
  const rowEditable = editable && !isOperating;
  const hasModelOverrideControl = supportsModelOverride(agent);
  // 有覆盖控件的行由控件本身表达模型，不再重复显示模型徽标。
  const showModelBadge = !hasModelOverrideControl;
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const modelLabel = resolveSubagentModelLabel({
    inheritLabel: inheritModelLabel,
    modelGroups: modelSelectGroups,
    model: toSubagentModelValue(agent.modelSelection),
  });
  const toolCount = agent.tools?.length ?? 0;
  const toolsLabel = allowsAllTools(agent.tools)
    ? intl.formatMessage({ id: "settings.subagents.tools.all" })
    : intl.formatMessage({ id: "settings.subagents.toolsCount" }, { count: String(toolCount) });
  const displayName =
    agent.source === "plugin" && agent.name.includes(":")
      ? agent.name.slice(agent.name.indexOf(":") + 1)
      : agent.name;

  return (
    <div
      data-testid={testId(TID_SUBAGENT_ROW, agent.name)}
      className={cn(
        "grid cursor-default items-center gap-3 px-4 py-3 transition-colors",
        rowEditable && "hover:bg-hover",
        hasModelOverrideControl
          ? "grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
      {...settingsResourceRowInteraction(rowEditable ? () => onEdit(agent) : undefined)}
    >
      <div className="relative shrink-0" aria-hidden="true">
        {pluginIconItem ? (
          <PluginStoreAvatar
            item={pluginIconItem}
            className="size-9 bg-background"
            fallbackIcon={<Bot className="size-4" />}
          />
        ) : (
          <div className="flex size-9 items-center justify-center rounded-xl bg-background text-foreground-subtle">
            <Bot className="size-4" />
          </div>
        )}
        {agent.color ? (
          // 右下角颜色点之前溢出头像容器，会让列表行视觉高度变高。
          <span className="absolute -bottom-1 -right-1 inline-flex size-3.5 items-center justify-center rounded-full border border-card bg-card p-px leading-none">
            <AgentColorDot color={agent.color} />
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{displayName}</span>
          {showModelBadge ? <AgentBadge>{modelLabel}</AgentBadge> : null}
          <AgentBadge>{toolsLabel}</AgentBadge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {agent.description || intl.formatMessage({ id: "settings.subagents.noDescription" })}
        </p>
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          hasModelOverrideControl
            ? "col-span-2 min-w-0 justify-end sm:col-span-1 sm:shrink-0"
            : "shrink-0",
        )}
      >
        {hasModelOverrideControl ? (
          <SubagentModelOverrideControl
            agent={agent}
            disabled={isOperating}
            modelGroups={modelGroups}
            modelSelectionView={modelSelectionView}
            modelSelectionLoading={modelSelectionLoading}
            onModelOverrideChange={onModelOverrideChange}
          />
        ) : null}
        {showEnabledToggle ? (
          <Switch
            checked={agent.enabled}
            onCheckedChange={(enabled) => onToggle(agent, enabled)}
            disabled={isOperating}
            aria-label={intl.formatMessage(
              { id: "settings.subagents.toggleAria" },
              { name: agent.name },
            )}
          />
        ) : null}
        <div className="flex items-center gap-1">
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              onClick={() => void onDelete(agent)}
              disabled={isOperating}
              title={intl.formatMessage({ id: "common.delete" })}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
