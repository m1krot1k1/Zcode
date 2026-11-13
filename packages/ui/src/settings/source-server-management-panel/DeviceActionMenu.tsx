import type { SourceServerRecord } from "@zcode/shared";
import { Copy, Ellipsis, ListTree, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { usePanelRuntime } from "./panelContext.js";

export function DeviceActionMenu({
  server,
  deviceBusy,
}: {
  server: SourceServerRecord;
  deviceBusy: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { run, workspaceTabs, snapshot, onShowInSidebar, removeSourceServer } = usePanelRuntime();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "common.more" })}
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-max min-w-64 [&_[data-slot=dropdown-menu-item]]:whitespace-nowrap"
      >
        {/*
          Bug 原因：「移除全部连接」曾被包在 online 分支里，简化 UI 删掉离线态的
          「重命名 / 迁移报告」后离线菜单变成空壳，离线设备再无任何移除入口。
          移除只删本机记录与凭据，Host removeSourceServer 会先幂等断开再删记录，
          不依赖远端在线；因此对所有已安装状态都渲染，只有「在侧边栏中显示」保留在线条件。
        */}
        {onShowInSidebar &&
        workspaceTabs.some(
          (tab) =>
            getWorkspaceSourceServerId(tab, {
              workspaceHistory: snapshot?.workspaceHistory,
            }) === server.sourceServerId,
        ) ? (
          <>
            <DropdownMenuItem onSelect={() => onShowInSidebar(server.sourceServerId)}>
              <ListTree className="size-3.5" />
              {intl.formatMessage({
                id: "settings.source.showInSidebar",
              })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <div
          className="max-w-80 space-y-1 px-2 py-2 text-ui-sm text-remote-foreground-muted"
          data-device-info
        >
          {[
            ["version", server.lastSeenVersion],
            ["hostname", server.hostname],
            ["osUser", server.osUser],
            ["deviceId", server.sourceServerId],
          ].map(([key, value]) => (
            <p key={key} className="break-all whitespace-normal">
              <span>{intl.formatMessage({ id: `settings.source.info.${key}` })}: </span>
              {value ?? intl.formatMessage({ id: "remote.infoUnavailable" })}
            </p>
          ))}
        </div>
        <DropdownMenuItem
          onSelect={() =>
            void run(`copy:${server.sourceServerId}`, async () => {
              await navigator.clipboard.writeText(server.sourceServerId);
            })
          }
        >
          <Copy className="size-3.5" />
          {intl.formatMessage({ id: "settings.source.copyDeviceId" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={deviceBusy}
          onSelect={() => void removeSourceServer(server)}
        >
          <Trash2 className="size-3.5" />
          {intl.formatMessage({
            id: "settings.source.removeSourceServer",
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
