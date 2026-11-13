import { useMemo } from "react";
import { CheckIcon, ChevronDown, ChevronRight, MinusIcon } from "lucide-react";
import type {
  SettingsSyncAgentSummary,
  SettingsSyncDiscoveryResult,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatAgentName,
  getResourceCategory,
  getSourceRootItems,
  groupAgentsBySourceRootScope,
  inferSourceRootScope,
} from "./discovery.js";
import { getResourceSelectionKey, getSourceSelectionKey } from "./selectionKeys.js";
import type { ImportItemSummary, ImportResourceCategory } from "./types.js";

export function ResourceSelectionRow({
  agent,
  category,
  sourceScope,
  selected,
  item,
  onToggleSelection,
}: {
  agent: SettingsSyncAgentSummary;
  category: ImportResourceCategory;
  sourceScope: SettingsSyncSourceScope;
  selected: Set<string>;
  item: ImportItemSummary;
  onToggleSelection: (key: string) => void;
}) {
  const itemKey = getResourceSelectionKey({
    agent: agent.agent,
    category,
    sourceScope,
    resourcePath: item.path,
  });
  const checked = selected.has(itemKey);

  return (
    <button
      type="button"
      onClick={() => onToggleSelection(itemKey)}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
            checked && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {checked ? <CheckIcon className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 truncate text-ui-base text-foreground">{item.name}</span>
        {"version" in item && item.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {item.version.startsWith("v") ? item.version : `v${item.version}`}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}

export function ImportSelectionList({
  category,
  discovery,
  workspacePath,
  activeScope,
  selectedKeys,
  expandedSourceKeys,
  onToggleSelection,
  onSetResourceSelection,
  onToggleExpanded,
}: {
  category: ImportResourceCategory;
  discovery: SettingsSyncDiscoveryResult;
  workspacePath: string | null | undefined;
  activeScope: SettingsSyncSourceScope;
  selectedKeys: string[];
  expandedSourceKeys: string[];
  onToggleSelection: (key: string) => void;
  onSetResourceSelection: (keys: string[], checked: boolean) => void;
  onToggleExpanded: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const expanded = useMemo(() => new Set(expandedSourceKeys), [expandedSourceKeys]);
  const scopes = useMemo(
    () => groupAgentsBySourceRootScope(discovery.agents, workspacePath, category),
    [category, discovery.agents, workspacePath],
  );
  const activeGroup = scopes.find((scope) => scope.scope === activeScope);
  const activeImportableResourceKeys = useMemo(
    () =>
      activeGroup?.rows.flatMap(({ agent, sourceRoot }) => {
        const resourceCategory = getResourceCategory(agent, category);
        if (!resourceCategory) {
          return [];
        }
        return getSourceRootItems(sourceRoot, category)
          .filter((item) => item.importable)
          .map((item) =>
            getResourceSelectionKey({
              agent: agent.agent,
              category,
              sourceScope: sourceRoot.scope,
              resourcePath: item.path,
            }),
          );
      }) ?? [],
    [activeGroup, category],
  );
  const activeSelectedCount = activeImportableResourceKeys.filter((key) =>
    selected.has(key),
  ).length;
  const allActiveSelected =
    activeImportableResourceKeys.length > 0 &&
    activeSelectedCount === activeImportableResourceKeys.length;
  const partiallyActiveSelected =
    activeSelectedCount > 0 && activeSelectedCount < activeImportableResourceKeys.length;
  const toggleAllLabel = intl.formatMessage({
    id: allActiveSelected
      ? `settings.${category}.import.clearAll`
      : `settings.${category}.import.selectAll`,
  });
  const hasClineMcpSource =
    category === "mcpServers" && discovery.agents.some((agent) => agent.agent === "cline");
  const sourceDiagnostics =
    category === "mcpServers"
      ? discovery.agents.flatMap((agent) =>
          agent.categories
            .filter((summary) => summary.category === "mcpServers")
            .flatMap((summary) =>
              (summary.diagnostics ?? [])
                .filter(
                  (diagnostic) =>
                    inferSourceRootScope(diagnostic.path, workspacePath) === activeScope,
                )
                .map((diagnostic) => ({ agent: agent.agent, ...diagnostic })),
            ),
        )
      : [];

  return (
    <div className="flex w-full flex-col gap-1">
      {hasClineMcpSource ? (
        <div
          role="note"
          className="mb-2 rounded-lg bg-warning-surface px-3 py-2 text-ui-base text-warning-surface-foreground"
        >
          {intl.formatMessage({
            id: "settings.mcpServers.import.clineSecurityNotice",
          })}
        </div>
      ) : null}
      {sourceDiagnostics.map((diagnostic) => (
        <div
          key={`${diagnostic.agent}:${diagnostic.path}:${diagnostic.code}`}
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground"
        >
          {intl.formatMessage(
            { id: `settings.mcpServers.import.diagnostic.${diagnostic.code}` },
            {
              agent: formatAgentName(diagnostic.agent, intl),
              path: diagnostic.path,
              count: String(diagnostic.count ?? 0),
            },
          )}
        </div>
      ))}
      {activeImportableResourceKeys.length > 0 ? (
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={partiallyActiveSelected ? "mixed" : allActiveSelected}
            aria-label={toggleAllLabel}
            onClick={() => onSetResourceSelection(activeImportableResourceKeys, !allActiveSelected)}
            className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-ui-base text-foreground-subtle transition-colors hover:text-foreground"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
                (allActiveSelected || partiallyActiveSelected) &&
                  "border-primary bg-primary text-primary-foreground",
              )}
            >
              {allActiveSelected ? <CheckIcon className="size-3.5" aria-hidden="true" /> : null}
              {partiallyActiveSelected ? (
                <MinusIcon className="size-3.5" aria-hidden="true" />
              ) : null}
            </span>
            <span className="shrink-0">{toggleAllLabel}</span>
          </button>
          <div className="min-w-0 text-right text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: `settings.${category}.import.selectionCount` },
              {
                selected: String(activeSelectedCount),
                total: String(activeImportableResourceKeys.length),
              },
            )}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {activeGroup?.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-3 py-6 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.scopeEmpty` })}
          </div>
        ) : null}
        {activeGroup?.rows.map(({ agent, sourceRoot }) => {
          const resourceCategory = getResourceCategory(agent, category);
          if (!resourceCategory) {
            return null;
          }
          const key = getSourceSelectionKey(agent.agent, category, sourceRoot.scope);
          const sourceKey = `${key}:${sourceRoot.path}`;
          const items = getSourceRootItems(sourceRoot, category).filter((item) => item.importable);
          const importableResourceKeys = items.map((item) =>
            getResourceSelectionKey({
              agent: agent.agent,
              category,
              sourceScope: sourceRoot.scope,
              resourcePath: item.path,
            }),
          );
          const selectedImportableCount = importableResourceKeys.filter((itemKey) =>
            selected.has(itemKey),
          ).length;
          const checked =
            importableResourceKeys.length > 0 &&
            selectedImportableCount === importableResourceKeys.length;
          const partiallyChecked =
            selectedImportableCount > 0 && selectedImportableCount < importableResourceKeys.length;
          const disabled = importableResourceKeys.length === 0;
          const isExpanded = expanded.has(sourceKey);

          return (
            <div key={sourceKey} className="rounded-lg">
              <div
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                  disabled ? "opacity-70" : "hover:bg-surface-hover/50",
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={intl.formatMessage({
                    id: checked
                      ? `settings.${category}.import.deselectSource`
                      : `settings.${category}.import.selectSource`,
                  })}
                  onClick={() => onSetResourceSelection(importableResourceKeys, !checked)}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md",
                    disabled ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border border-border",
                      (checked || partiallyChecked) &&
                        !disabled &&
                        "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked && !disabled ? <CheckIcon className="size-3.5" /> : null}
                    {partiallyChecked && !disabled ? <MinusIcon className="size-3.5" /> : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-left"
                >
                  <span className="text-ui-base font-medium text-foreground">
                    {formatAgentName(agent.agent, intl)}
                  </span>
                  <span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">
                    {sourceRoot.path}
                  </span>
                  {items.length > 0 ? (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage(
                        { id: `settings.${category}.import.itemCount` },
                        { count: String(items.length) },
                      )}
                    </span>
                  ) : null}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: isExpanded
                      ? `settings.${category}.import.collapseSource`
                      : `settings.${category}.import.expandSource`,
                  })}
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </Button>
              </div>
              {isExpanded ? (
                <div className="ml-9 border-l border-border pl-3">
                  {items.map((item) => (
                    <ResourceSelectionRow
                      key={`${sourceKey}:${item.path}`}
                      agent={agent}
                      category={category}
                      sourceScope={sourceRoot.scope}
                      selected={selected}
                      item={item}
                      onToggleSelection={onToggleSelection}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
