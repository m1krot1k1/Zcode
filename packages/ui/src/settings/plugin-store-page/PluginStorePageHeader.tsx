import { ArrowLeft, RefreshCw, Store } from "lucide-react";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { PluginAddMenu } from "@/conversation-workspace-target/PluginAddMenu.js";
import type { PluginStoreIntl } from "./types.js";

/** 商店列表顶栏：标题 + 刷新 / 市场源 / 新建 / 管理已安装。 */
export function PluginStorePageHeader({
  intl,
  refreshing,
  onRefresh,
  onOpenSources,
  onAddMarketplace,
  onManage,
  onBack,
  isWebRemoteControl,
  onCreateTask,
}: {
  intl: PluginStoreIntl;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSources: () => void;
  onAddMarketplace: () => void;
  onManage: () => void;
  onBack?: () => void;
  isWebRemoteControl: boolean;
  onCreateTask?: (request?: CreateTaskRequest) => void;
}) {
  return (
    // 对齐原型：标题与动作同一行、去掉副标题，压缩头部信息密度。
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={intl.formatMessage({ id: "project.back" })}
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <h1
          data-testid="plugin-store-title"
          className="text-ui-xl font-semibold tracking-tight text-foreground"
        >
          {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
        </h1>
      </div>
      {/* 顶栏动作：刷新 / 市场源管理 / 添加 / 插件管理。 */}
      <div className="flex flex-wrap items-center gap-2">
        <ControlHintTooltip
          title={
            refreshing
              ? intl.formatMessage({ id: "settings.plugins.refreshing" })
              : intl.formatMessage({ id: "settings.plugins.refresh" })
          }
        >
          <Button
            type="button"
            data-testid="plugin-store-refresh"
            variant="secondary"
            size="icon-lg"
            aria-label={
              refreshing
                ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                : intl.formatMessage({ id: "settings.plugins.refresh" })
            }
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
              aria-hidden="true"
            />
          </Button>
        </ControlHintTooltip>
        <ControlHintTooltip
          title={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
        >
          <Button
            type="button"
            data-testid="plugin-store-sources-open"
            variant="secondary"
            size="icon-lg"
            aria-label={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
            onClick={onOpenSources}
          >
            <Store className="size-3.5" aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
        <PluginAddMenu
          testId="plugin-store-create"
          variant="secondary"
          size="lg"
          isWebRemoteControl={isWebRemoteControl}
          onCreateTask={onCreateTask}
          onAddMarketplace={onAddMarketplace}
        />
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="font-medium"
          data-testid="plugin-store-manage-open"
          onClick={onManage}
        >
          {intl.formatMessage({ id: "settings.plugins.store.manageInstalled" })}
        </Button>
      </div>
    </div>
  );
}
