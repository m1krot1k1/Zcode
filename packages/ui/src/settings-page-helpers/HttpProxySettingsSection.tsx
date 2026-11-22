/**
 * HTTP 代理设置分组：代理列表入口、管理弹窗、No Proxy 与自定义 CA 路径。
 *
 * 从 `GeneralSectionContent` 内联卡片原样拆出；卡片内的行顺序、文案 key、
 * 禁用条件与 test id 保持不变，状态与动作来自 `useHttpProxySettings`。
 */
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IPlatformService } from "@zcode/shared";
import { HttpProxyManagerDialog } from "@/settings-page-helpers/HttpProxyManagerDialog.js";
import { sanitizeProxyRouteForDisplay } from "@/settings-page-helpers/sanitizeProxyRouteForDisplay.js";
import type { HttpProxySettingsController } from "@/settings-page-helpers/useHttpProxySettings.js";

export interface HttpProxySettingsSectionProps {
  proxy: HttpProxySettingsController;
  httpProxy: string;
  httpProxyList: string;
  platform?: IPlatformService;
  onHttpProxyChange: (httpProxy: string) => Promise<void>;
}

export function HttpProxySettingsSection({
  proxy,
  httpProxy,
  httpProxyList,
  platform,
  onHttpProxyChange,
}: HttpProxySettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const {
    proxyListEntries,
    normalizeProxyRow,
    proxyDialogOpen,
    setProxyDialogOpen,
    proxyRows,
    setProxyRows,
    proxyChecks,
    setProxyChecks,
    proxyTestRunRef,
    handleProxyTestsAll,
    handleProxyListSave,
    handleProxyUse,
    localHttpProxyNoProxy,
    setLocalHttpProxyNoProxy,
    isHttpProxyNoProxyDirty,
    handleHttpProxyNoProxySave,
    localHttpProxyCaCertPath,
    setLocalHttpProxyCaCertPath,
    isHttpProxyCaCertPathDirty,
    handleHttpProxyCaCertPathSave,
  } = proxy;

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.httpProxyList" })}
        description={intl.formatMessage({
          id: "settings.httpProxyListDescription",
        })}
        control={
          <Button
            type="button"
            size="lg"
            data-testid="settings-http-proxy-manage"
            onClick={() => {
              proxyTestRunRef.current += 1;
              setProxyRows(proxyListEntries);
              setProxyChecks({});
              setProxyDialogOpen(true);
            }}
          >
            <Plus className="mr-2 size-4" />
            {intl.formatMessage({ id: "settings.httpProxyManage" })}
          </Button>
        }
        detail={
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.httpProxyActive" })}:{" "}
            {sanitizeProxyRouteForDisplay(httpProxy) ||
              intl.formatMessage({ id: "settings.httpProxyDirect" })}
          </div>
        }
      />
      <HttpProxyManagerDialog
        open={proxyDialogOpen}
        onOpenChange={setProxyDialogOpen}
        proxyRows={proxyRows}
        setProxyRows={setProxyRows}
        proxyChecks={proxyChecks}
        setProxyChecks={setProxyChecks}
        proxyTestRunRef={proxyTestRunRef}
        proxyListEntries={proxyListEntries}
        normalizeProxyRow={normalizeProxyRow}
        httpProxy={httpProxy}
        httpProxyList={httpProxyList}
        platform={platform}
        handleProxyUse={handleProxyUse}
        handleProxyTestsAll={handleProxyTestsAll}
        handleProxyListSave={handleProxyListSave}
        onHttpProxyChange={onHttpProxyChange}
      />
      {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
      <SettingsRow
        label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
        description={intl.formatMessage({
          id: "settings.httpProxyNoProxyDescription",
        })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={!isHttpProxyNoProxyDirty}
            onClick={() => void handleHttpProxyNoProxySave()}
          >
            {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
          </Button>
        }
        detail={
          <Input
            size="lg"
            value={localHttpProxyNoProxy}
            placeholder={intl.formatMessage({
              id: "settings.httpProxyNoProxyPlaceholder",
            })}
            onChange={(event) => {
              setLocalHttpProxyNoProxy(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                void handleHttpProxyNoProxySave();
              }
            }}
            className="max-w-[520px] font-mono"
          />
        }
      />
      {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
      <SettingsRow
        label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
        description={intl.formatMessage({
          id: "settings.httpProxyCaCertPathDescription",
        })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={!isHttpProxyCaCertPathDirty}
            onClick={() => void handleHttpProxyCaCertPathSave()}
          >
            {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
          </Button>
        }
        detail={
          <Input
            size="lg"
            value={localHttpProxyCaCertPath}
            placeholder={intl.formatMessage({
              id: "settings.httpProxyCaCertPathPlaceholder",
            })}
            onChange={(event) => {
              setLocalHttpProxyCaCertPath(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                void handleHttpProxyCaCertPathSave();
              }
            }}
            className="max-w-[520px] font-mono"
          />
        }
      />
    </SettingsGroupCard>
  );
}
