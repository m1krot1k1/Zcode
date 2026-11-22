/**
 * MCP Settings — editor (form/JSON) view for a single MCP server entry.
 */
import type { ZCodeMcpServer } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { McpServerForm } from "@/settings/McpServerForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import type { FormState, McpEditorMode } from "@/settings/mcpSettingsShared.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export function McpSettingsEditorView({
  editingServer,
  presetDraft,
  editorMode,
  formScopeKey,
  workspaceTabs,
  showMarketplaceBreadcrumb,
  onOpenPluginStore,
  onClose,
  onEditorModeChange,
  onScopeKeyChange,
  onSave,
  onDelete,
}: {
  editingServer: ZCodeMcpServer | null;
  presetDraft: ZCodeMcpServer | null;
  editorMode: McpEditorMode;
  formScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  showMarketplaceBreadcrumb: boolean;
  onOpenPluginStore?: () => void;
  onClose: () => void;
  onEditorModeChange: (mode: McpEditorMode) => void;
  onScopeKeyChange: (scopeKey: string) => void;
  onSave: (form: FormState, prev?: ZCodeMcpServer) => Promise<void>;
  onDelete?: (server: ZCodeMcpServer) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
  const formBreadcrumbLabel =
    editingServer?.name ?? intl.formatMessage({ id: "settings.mcp.form.createTitle" });

  return (
    <div className="space-y-6">
      <SettingsBreadcrumbReporter
        items={
          showMarketplaceBreadcrumb
            ? [{ label: pluginsBreadcrumbLabel, onSelect: onClose }, { label: formBreadcrumbLabel }]
            : [{ label: formBreadcrumbLabel }]
        }
        onSectionSelect={
          showMarketplaceBreadcrumb && onOpenPluginStore ? onOpenPluginStore : onClose
        }
      />
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingServer
                ? intl.formatMessage({ id: "settings.mcp.form.editTitle" })
                : intl.formatMessage({ id: "settings.mcp.form.createTitle" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingServer
                ? intl.formatMessage({
                    id: "settings.mcp.form.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.mcp.form.createDescription",
                  })}
            </p>
          </div>
          <div className="shrink-0 self-end">
            <SettingsSegmentedTabs
              value={editorMode}
              items={[
                {
                  value: "form",
                  label: intl.formatMessage({
                    id: "settings.mcp.form.mode.form",
                  }),
                },
                { value: "json", label: "JSON" },
              ]}
              onValueChange={onEditorModeChange}
            />
          </div>
        </div>

        <McpServerForm
          initial={editingServer ?? presetDraft ?? undefined}
          editingId={editingServer?.id}
          editorMode={editorMode}
          source={editingServer?.source ?? "zcodeagentmcp"}
          scopeKey={formScopeKey}
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={onScopeKeyChange}
          onEditorModeChange={onEditorModeChange}
          onSave={onSave}
          onDelete={editingServer ? onDelete : undefined}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
