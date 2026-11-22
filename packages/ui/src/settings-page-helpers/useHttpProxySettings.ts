/**
 * HTTP 代理设置分组的视图模型：代理列表行、连通性检测、No Proxy 与 CA 路径草稿态。
 *
 * 从 `GeneralSectionContent` 内联状态与回调原样提取（含 runId 防串号逻辑），
 * state/effect/useCallback 的声明顺序保持与拆分前一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService } from "@zcode/shared";

export type HttpProxyCheckState =
  | { state: "checking" }
  | { state: "ok"; ip: string }
  | {
      state: "error";
      reason: "invalid_proxy" | "connection_failed" | "timeout" | "invalid_response";
    };

export type HttpProxyChecks = Record<number, HttpProxyCheckState>;

export interface UseHttpProxySettingsParams {
  httpProxy: string;
  httpProxyList: string;
  httpProxyNoProxy: string;
  httpProxyCaCertPath: string;
  platform?: IPlatformService;
  onHttpProxyChange: (httpProxy: string) => Promise<void>;
  onHttpProxyListChange: (proxyList: string) => Promise<void>;
  onHttpProxyNoProxyChange: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange: (caCertPath: string) => Promise<void>;
}

export function useHttpProxySettings({
  httpProxy,
  httpProxyList,
  httpProxyNoProxy,
  httpProxyCaCertPath,
  platform,
  onHttpProxyChange,
  onHttpProxyListChange,
  onHttpProxyNoProxyChange,
  onHttpProxyCaCertPathChange,
}: UseHttpProxySettingsParams) {
  const proxyListEntries = Array.from(
    new Set(
      [...httpProxyList.split(/\r?\n/u), httpProxy].map((proxy) => proxy.trim()).filter(Boolean),
    ),
  );
  const [proxyDialogOpen, setProxyDialogOpen] = useState(false);
  const [proxyRows, setProxyRows] = useState<string[]>(proxyListEntries);
  const [proxyChecks, setProxyChecks] = useState<HttpProxyChecks>({});
  const proxyTestRunRef = useRef(0);

  useEffect(() => {
    proxyTestRunRef.current += 1;
    setProxyRows(proxyListEntries);
    setProxyChecks({});
  }, [httpProxy, httpProxyList]);

  const normalizeProxyRow = (raw: string) => {
    const value = raw.trim();
    const shorthand = value.match(/^([^:/\s]+):(\d+):([^:]*):(.*)$/u);
    if (shorthand) {
      return `socks5://${encodeURIComponent(shorthand[3] ?? "")}:${encodeURIComponent(shorthand[4] ?? "")}@${shorthand[1]}:${shorthand[2]}`;
    }
    return value.replace(/^socks:\/\//iu, "socks5://");
  };

  const handleProxyTestsAll = async () => {
    const testProxy = platform?.testProxyConnectivity;
    if (!testProxy) return;
    const entries = proxyRows
      .map((proxy, index) => ({ index, endpoint: normalizeProxyRow(proxy) }))
      .filter((entry) => entry.endpoint);
    if (!entries.length) return;

    const runId = ++proxyTestRunRef.current;
    setProxyChecks(Object.fromEntries(entries.map(({ index }) => [index, { state: "checking" }])));
    const results = await Promise.all(
      entries.map(async ({ index, endpoint }) => {
        const result = await testProxy(endpoint).catch(() => ({
          ok: false as const,
          reason: "connection_failed" as const,
        }));
        return [
          index,
          result.ok
            ? { state: "ok" as const, ip: result.outboundIp }
            : { state: "error" as const, reason: result.reason },
        ] as const;
      }),
    );
    if (proxyTestRunRef.current !== runId) return;
    setProxyChecks(Object.fromEntries(results));
  };

  const handleProxyListSave = async () => {
    proxyTestRunRef.current += 1;
    const normalized = Array.from(new Set(proxyRows.map(normalizeProxyRow).filter(Boolean))).join(
      "\n",
    );
    await onHttpProxyListChange(normalized);
    setProxyRows(normalized ? normalized.split("\n") : []);
    setProxyChecks({});
    setProxyDialogOpen(false);
  };

  const handleProxyUse = async (index: number) => {
    const endpoint = normalizeProxyRow(proxyRows[index] ?? "");
    if (endpoint && proxyListEntries.includes(endpoint)) {
      await onHttpProxyChange(endpoint);
    }
  };

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return {
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
  };
}

export type HttpProxySettingsController = ReturnType<typeof useHttpProxySettings>;
