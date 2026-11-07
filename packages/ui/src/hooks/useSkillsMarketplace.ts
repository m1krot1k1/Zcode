import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InstallMarketplaceSkillRequest,
  InstallMarketplaceSkillResult,
  MarketplaceSkillInfo,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** 与 shared 契约保持一致，避免在 UI 层重复声明安装范围字面量。 */
export type SkillInstallScope = InstallMarketplaceSkillRequest["scope"];

interface UseSkillsMarketplaceOptions {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

interface SkillsMarketplaceInstallError {
  name: string;
  message: string;
}

/**
 * 搜索结果条目的稳定标识：`source` 为 `owner/repo`，同名的不同来源必须区分开，
 * 因此列表 key、每行安装状态都用复合 key；来源缺失时回退为裸名称。
 */
export function marketplaceSkillKey(item: MarketplaceSkillInfo): string {
  const source = item.source?.trim();
  const skillId = item.skillId?.trim() || item.name;
  return source ? `${source}/${skillId}` : skillId;
}

/**
 * 安装请求的 `name`：契约接受 `owner/repo/skillId`（搜索结果 `source` + `name`）
 * 或裸技能名；有来源时用完整引用，避免同名技能落到错误来源。
 */
function marketplaceInstallName(item: MarketplaceSkillInfo): string {
  return marketplaceSkillKey(item);
}

interface UseSkillsMarketplaceResult {
  items: MarketplaceSkillInfo[];
  submittedQuery: string;
  hasSearched: boolean;
  loading: boolean;
  error: string | null;
  /** 正在安装条目的复合 key（见 `marketplaceSkillKey`）；无安装时为 null。 */
  installingKey: string | null;
  installError: SkillsMarketplaceInstallError | null;
  installedNotice: string | null;
  search: (query: string) => Promise<void>;
  retry: () => Promise<void>;
  install: (item: MarketplaceSkillInfo, scope: SkillInstallScope) => Promise<void>;
}

/**
 * skills.sh 公共技能市场：搜索 + 安装。
 * 搜索/安装都经由 useServices().skillsService，组件不得直接访问服务实现。
 * 安装成功后重跑最近一次搜索，让 installed 标记回到服务端扫描事实，
 * 而不是只做一次性的本地乐观更新。
 */
export function useSkillsMarketplace(
  options: UseSkillsMarketplaceOptions,
): UseSkillsMarketplaceResult {
  const { skillsService } = useServices();
  const workspacePath = options.workspacePath?.trim() || undefined;
  const workspaceIdentity = options.workspaceIdentity?.trim() || undefined;
  const [items, setItems] = useState<MarketplaceSkillInfo[]>([]);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installError, setInstallError] = useState<SkillsMarketplaceInstallError | null>(null);
  const [installedNotice, setInstalledNotice] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const lastQueryRef = useRef("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      const seq = ++requestSeqRef.current;
      lastQueryRef.current = query;
      setSubmittedQuery(query);
      setHasSearched(true);
      setInstallError(null);
      if (!query) {
        setItems([]);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await skillsService.searchMarketplace(query, {
          ...(workspacePath ? { workspacePath } : {}),
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        if (seq !== requestSeqRef.current || !mountedRef.current) return;
        setItems(result);
        setLoading(false);
      } catch (cause) {
        if (seq !== requestSeqRef.current || !mountedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[useSkillsMarketplace] 搜索 skills.sh 失败", { error: message, query });
        setItems([]);
        setError(message);
        setLoading(false);
      }
    },
    [skillsService, workspaceIdentity, workspacePath],
  );

  const search = useCallback(
    async (query: string) => {
      setInstalledNotice(null);
      await runSearch(query);
    },
    [runSearch],
  );

  const retry = useCallback(async () => {
    await runSearch(lastQueryRef.current);
  }, [runSearch]);

  const install = useCallback(
    async (item: MarketplaceSkillInfo, scope: SkillInstallScope) => {
      const installName = marketplaceInstallName(item);
      const key = marketplaceSkillKey(item);
      setInstallingKey(key);
      setInstallError(null);
      setInstalledNotice(null);
      try {
        const result: InstallMarketplaceSkillResult =
          await skillsService.installMarketplaceSkill({
            name: installName,
            scope,
            ...(workspacePath ? { workspacePath } : {}),
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
        if (!mountedRef.current) return;
        setInstalledNotice(result.name);
        // 先按安装结果标记当前行，避免刷新搜索期间按钮仍显示可安装。
        setItems((current) =>
          current.map((entry) =>
            marketplaceSkillKey(entry) === key ||
            (entry.name === result.name && entry.source === item.source)
              ? { ...entry, installed: true }
              : entry,
          ),
        );
        if (lastQueryRef.current) {
          await runSearch(lastQueryRef.current);
        }
      } catch (cause) {
        if (!mountedRef.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[useSkillsMarketplace] 安装 skills.sh 技能失败", {
          error: message,
          name: installName,
          scope,
        });
        setInstallError({ name: item.name, message });
      } finally {
        if (mountedRef.current) setInstallingKey(null);
      }
    },
    [runSearch, skillsService, workspaceIdentity, workspacePath],
  );

  return {
    items,
    submittedQuery,
    hasSearched,
    loading,
    error,
    installingKey,
    installError,
    installedNotice,
    search,
    retry,
    install,
  };
}
