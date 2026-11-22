import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOpenPluginUi, PluginUiLauncherItems, SidePaneLauncherRow } from "@/plugin-ui/index.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenTabLauncherItem } from "@/app-shell/animated-side-pane-panel/openTabLauncherItems.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];
type OpenPluginUi = ReturnType<typeof useOpenPluginUi>;

/**
 * 「打开标签页」空白页：内置应用 + 推荐 UI 插件。
 * 插件市场入口只上报点击，返回目标由面板持有（关闭市场后要回到原 tab）。
 */
export function SidePaneOpenTabLauncher({
  items,
  activeTaskId,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  intl,
  onOpenPluginMarket,
  onOpenPluginUi,
}: {
  items: OpenTabLauncherItem[];
  activeTaskId: string | null;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  intl: IntlShape;
  onOpenPluginMarket?: () => void;
  onOpenPluginUi: OpenPluginUi;
}) {
  return (
    <div className="side-pane-open-tab-shell @container/launcher flex h-full min-h-0 flex-col bg-background">
      {/* 对齐原型：顶部对齐滚动、左对齐标题；内置应用与 UI 插件同为横向行，短分割线分区。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "sidePane.openTab" })}
          </h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
            {items.map((item) => (
              <SidePaneLauncherRow
                key={item.id}
                itemId={item.id}
                icon={item.icon}
                label={item.label}
                description={item.description}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {/* 空会话暂不支持应用插件，连同分区入口一起隐藏。 */}
          {activeTaskId ? (
            <>
              <div aria-hidden="true" className="my-4 h-px w-24 self-center bg-border" />
              <section className="min-w-0" data-testid="side-pane-ui-recommendations">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <h2 className="pl-2 text-ui-lg font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.store.ui.title" })}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-foreground-subtle"
                    data-testid="side-pane-plugin-market"
                    onClick={onOpenPluginMarket}
                  >
                    {intl.formatMessage({ id: "sidePane.launcher.viewAllPlugins" })}
                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
                  {onOpenPluginUi ? (
                    <PluginUiLauncherItems
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={workspaceRemoteSessionId}
                      sessionId={activeTaskId}
                      onOpenPluginUi={onOpenPluginUi}
                    />
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
