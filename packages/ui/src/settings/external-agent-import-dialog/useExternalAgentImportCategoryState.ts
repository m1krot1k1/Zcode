import { useCallback, useEffect, useMemo, useState } from "react";
import type { ISettingsSyncService } from "./contract.ts";
import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncImportMode,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { normalizeError } from "./discovery.js";
import { buildExternalAgentImportSelections } from "./selectionKeys.js";
import type { ExternalAgentImportCategoryState, ImportResourceCategory } from "./types.js";

/**
 * 单个资源类别的扫描/选择状态机。
 *
 * 调用方（设置页弹窗与 onboarding）只在 `enabled` 后触发一次 detect，
 * 之后由 `loadDiscovery` 显式重扫，避免重复的自动请求。
 */
export function useExternalAgentImportCategoryState({
  category,
  enabled,
  settingsSyncService,
  workspaceIdentity,
  workspacePath,
}: {
  category: ImportResourceCategory;
  enabled: boolean;
  settingsSyncService: ISettingsSyncService;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
}): ExternalAgentImportCategoryState {
  const [loading, setLoading] = useState(false);
  const [discovery, setDiscovery] = useState<SettingsSyncDiscoveryResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [expandedSourceKeys, setExpandedSourceKeys] = useState<string[]>([]);
  const [activeScope, setActiveScope] = useState<SettingsSyncSourceScope>("global");
  const [importTargetScope, setImportTargetScope] = useState<SettingsSyncSourceScope>("global");
  const [importMode, setImportMode] = useState<SettingsSyncImportMode>("symlink");
  const [error, setError] = useState<string | null>(null);

  const totalImportableCount = useMemo(
    () =>
      discovery?.agents.reduce(
        (sum, agent) =>
          sum +
          agent.categories.reduce(
            (categorySum, category) => categorySum + category.importableCount,
            0,
          ),
        0,
      ) ?? 0,
    [discovery],
  );

  const loadDiscovery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextDiscovery = await settingsSyncService.detect({
        workspacePath: workspacePath ?? undefined,
        workspaceIdentity,
        categories: [category],
        intent: "manualImport",
      });
      setDiscovery(nextDiscovery);
      setSelectedKeys([]);
      setExpandedSourceKeys([]);
      setActiveScope("global");
      setImportTargetScope("global");
    } catch (loadError) {
      const message = normalizeError(loadError);
      logger.error("[ExternalAgentImportDialog] scan failed", { category, error: message });
      setError(message);
      setDiscovery({ agents: [] });
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  }, [category, settingsSyncService, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!enabled || discovery || loading) {
      return;
    }
    void loadDiscovery();
  }, [discovery, enabled, loadDiscovery, loading]);

  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return [...next];
    });
  }, []);

  const setResourceSelection = useCallback((keys: string[], checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return [...next];
    });
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedSourceKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }, []);

  const setActiveSourceScope = useCallback((nextScope: SettingsSyncSourceScope) => {
    setActiveScope(nextScope);
    setImportTargetScope(nextScope);
  }, []);

  const selections = useMemo(
    () => buildExternalAgentImportSelections(selectedKeys, importTargetScope, importMode),
    [importMode, importTargetScope, selectedKeys],
  );

  return {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount: selectedKeys.length,
    selectedKeys,
    selections,
    totalImportableCount,
    loadDiscovery,
    setActiveSourceScope,
    setImportMode,
    setImportTargetScope,
    setResourceSelection,
    toggleExpanded,
    toggleSelection,
  };
}
