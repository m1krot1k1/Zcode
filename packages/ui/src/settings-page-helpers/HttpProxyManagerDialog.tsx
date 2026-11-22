/**
 * HTTP 代理管理弹窗：多行编辑、逐行检测状态、启用/删除/直连与保存。
 *
 * 从 `GeneralSectionContent` 内联的 Dialog 原样拆出；test id、按钮禁用条件与
 * 行内归一化调用顺序保持不变，状态仍由 `useHttpProxySettings` 持有。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IPlatformService } from "@zcode/shared";
import { sanitizeProxyRouteForDisplay } from "@/settings-page-helpers/sanitizeProxyRouteForDisplay.js";
import type { HttpProxyChecks } from "@/settings-page-helpers/useHttpProxySettings.js";

export interface HttpProxyManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proxyRows: string[];
  setProxyRows: Dispatch<SetStateAction<string[]>>;
  proxyChecks: HttpProxyChecks;
  setProxyChecks: Dispatch<SetStateAction<HttpProxyChecks>>;
  proxyTestRunRef: RefObject<number>;
  proxyListEntries: string[];
  normalizeProxyRow: (raw: string) => string;
  httpProxy: string;
  httpProxyList: string;
  platform?: IPlatformService;
  handleProxyUse: (index: number) => Promise<void>;
  handleProxyTestsAll: () => Promise<void>;
  handleProxyListSave: () => Promise<void>;
  onHttpProxyChange: (httpProxy: string) => Promise<void>;
}

export function HttpProxyManagerDialog({
  open,
  onOpenChange,
  proxyRows,
  setProxyRows,
  proxyChecks,
  setProxyChecks,
  proxyTestRunRef,
  proxyListEntries,
  normalizeProxyRow,
  httpProxy,
  httpProxyList,
  platform,
  handleProxyUse,
  handleProxyTestsAll,
  handleProxyListSave,
  onHttpProxyChange,
}: HttpProxyManagerDialogProps) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(85vh,760px)] max-w-3xl grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-popover-border px-5 py-4 pr-12">
          <DialogTitle>{intl.formatMessage({ id: "settings.httpProxyManage" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id: "settings.httpProxyDialogDescription",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto p-5">
          <Textarea
            aria-label={intl.formatMessage({
              id: "settings.httpProxyListEditor",
            })}
            data-testid="settings-proxy-list-editor"
            value={proxyRows.join("\n")}
            placeholder={intl.formatMessage({
              id: "settings.httpProxyListPlaceholder",
            })}
            onChange={(event) => {
              proxyTestRunRef.current += 1;
              setProxyRows(event.currentTarget.value.split(/\r?\n/u));
              setProxyChecks({});
            }}
            className="min-h-36 resize-y font-mono"
            spellCheck={false}
          />
          {proxyRows.map((proxy, index) => {
            if (!proxy.trim()) return null;
            const check = proxyChecks[index];
            return (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                data-testid={`settings-proxy-row-${index}`}
              >
                <div className="min-w-[220px] flex-1 break-all font-mono text-ui-sm">
                  {normalizeProxyRow(proxy)}
                </div>
                <Button
                  type="button"
                  variant={httpProxy === normalizeProxyRow(proxy) ? "secondary" : "outline"}
                  disabled={!proxy.trim() || !proxyListEntries.includes(normalizeProxyRow(proxy))}
                  data-testid={`settings-proxy-use-${index}`}
                  onClick={() => void handleProxyUse(index)}
                >
                  {httpProxy === normalizeProxyRow(proxy) ? (
                    <Check className="mr-2 size-4" />
                  ) : null}
                  {intl.formatMessage({ id: "settings.httpProxyUse" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({
                    id: "settings.httpProxyRemove",
                  })}
                  data-testid={`settings-proxy-remove-${index}`}
                  onClick={() => {
                    proxyTestRunRef.current += 1;
                    setProxyRows((current) =>
                      current.filter((_row, rowIndex) => rowIndex !== index),
                    );
                    setProxyChecks({});
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
                {check?.state === "ok" ? (
                  <div
                    className="flex w-full items-center gap-2 text-ui-sm text-success"
                    data-testid={`settings-proxy-status-${index}`}
                  >
                    <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.httpProxyWorking" }, { ip: check.ip })}
                  </div>
                ) : check?.state === "error" ? (
                  <div
                    className="flex w-full items-center gap-2 text-ui-sm text-destructive"
                    data-testid={`settings-proxy-status-${index}`}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full bg-destructive"
                      aria-hidden="true"
                    />
                    {intl.formatMessage({
                      id:
                        check.reason === "timeout"
                          ? "settings.httpProxyFailedTimeout"
                          : check.reason === "invalid_response"
                            ? "settings.httpProxyFailedResponse"
                            : check.reason === "invalid_proxy"
                              ? "settings.httpProxyFailedInvalid"
                              : "settings.httpProxyFailedConnection",
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter className="border-t border-popover-border px-5 py-4 sm:justify-between">
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.httpProxyCurrent" })}:{" "}
            {sanitizeProxyRouteForDisplay(httpProxy) ||
              intl.formatMessage({ id: "settings.httpProxyDirect" })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="settings-proxy-use-direct"
              onClick={() => void onHttpProxyChange("")}
            >
              {intl.formatMessage({ id: "settings.httpProxyUseDirect" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="settings-proxy-test-all"
              disabled={
                !proxyRows.some((proxy) => normalizeProxyRow(proxy)) ||
                Object.values(proxyChecks).some((check) => check.state === "checking") ||
                !platform?.testProxyConnectivity
              }
              onClick={() => void handleProxyTestsAll()}
            >
              {intl.formatMessage({
                id: Object.values(proxyChecks).some((check) => check.state === "checking")
                  ? "settings.httpProxyTestingAll"
                  : "settings.httpProxyTestAll",
              })}
            </Button>
            <Button
              type="button"
              data-testid="settings-proxy-save"
              disabled={
                proxyRows.map(normalizeProxyRow).filter(Boolean).join("\n") === httpProxyList
              }
              onClick={() => void handleProxyListSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
