import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceResult } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * 系统自动安装「提示词增强器」自己提出的技能建议。
 *
 * 产品规则：建议列表由应用自身产生时，技能安装不再等用户确认，由系统在结果到达后
 * 自动完成（见 docs/specs/2026-11-21-prompt-enhancer-no-questions.md）。其它来源的
 * 技能仍在市场/设置面板手动安装。
 *
 * 状态由本 hook 独占：`installing`/`installed`/`error` 只在这里推进；`settledRef`
 * 记录「已发起过安装」的技能名，effect 重入或同一建议多次到达都不会重复下载。
 */

/** 只声明用到的技能服务方法；结构化类型让 UI 测试可用最小替身。 */
export interface SuggestedSkillInstaller {
  installMarketplaceSkill(request: {
    name: string;
    scope?: "workspace" | "user";
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<{ name: string }>;
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ skills: ReadonlyArray<{ id: string; name: string }> }>;
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

export type SuggestedSkillInstallPhase = "installing" | "installed" | "error" | "removed";

export interface SuggestedSkillInstallEntry {
  phase: SuggestedSkillInstallPhase;
  /** Host 返回的错误原文，只用于行内提示，不参与控制流。 */
  error?: string;
}

export interface SuggestedSkillAutoInstallOptions {
  /** 本次增强结果；null 表示还没有建议，什么都不做。 */
  result: PromptEnhanceResult | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** `promptEnhancerSettings.autoInstallSuggestedSkills`，默认 true。 */
  enabled: boolean;
  /** 技能服务缺失时保持只读展示（例如受限 Host）。 */
  install: SuggestedSkillInstaller | null;
  /** 安装或删除成功后刷新技能列表；刷新失败不影响安装结果。 */
  onSkillListChanged?: () => void;
}

export interface SuggestedSkillAutoInstallState {
  statuses: Readonly<Record<string, SuggestedSkillInstallEntry>>;
  /** 显式重试某个失败的技能；自动流程不会自己重试，避免失败循环。 */
  retry: (name: string) => void;
  /** 删除已安装的建议技能，需要调用方先做确认。 */
  remove: (name: string) => Promise<void>;
  removingSkill: string | null;
}

export function useSuggestedSkillAutoInstall(
  options: SuggestedSkillAutoInstallOptions,
): SuggestedSkillAutoInstallState {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [statuses, setStatuses] = useState<Record<string, SuggestedSkillInstallEntry>>({});
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);
  const settledRef = useRef(new Map<string, Promise<void>>());
  const runningRef = useRef(new Set<string>());

  const installOne = useCallback(
    async (suggestion: PromptEnhanceCapabilitySuggestion): Promise<void> => {
      const current = optionsRef.current;
      const installer = current.install;
      if (!installer || runningRef.current.has(suggestion.name)) return;
      runningRef.current.add(suggestion.name);
      setStatuses((previous) => ({
        ...previous,
        [suggestion.name]: { phase: "installing" },
      }));
      try {
        const installed = await installer.installMarketplaceSkill({
          name: suggestion.name,
          scope: "workspace",
          workspacePath: current.workspacePath,
          ...(current.workspaceIdentity
            ? { workspaceIdentity: current.workspaceIdentity }
            : {}),
        });
        setStatuses((previous) => ({
          ...previous,
          [suggestion.name]: { phase: "installed" },
        }));
        logger.info("Suggested skill installed automatically", {
          kind: suggestion.kind,
          name: installed.name,
        });
        current.onSkillListChanged?.();
      } catch (error) {
        // 安装失败只降级为行内错误：面板和输入区不能因为建议安装失败而中断。
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Suggested skill auto-install failed", {
          kind: suggestion.kind,
          name: suggestion.name,
          error: message,
        });
        setStatuses((previous) => ({
          ...previous,
          [suggestion.name]: { phase: "error", error: message },
        }));
      } finally {
        runningRef.current.delete(suggestion.name);
      }
    },
    [],
  );

  const { enabled } = options;
  const result = options.result;
  const installer = options.install;
  useEffect(() => {
    if (!enabled || !result || !installer) return;
    const candidates = result.capabilitySuggestions.filter(
      (suggestion) =>
        suggestion.kind === "skill" &&
        !suggestion.installed &&
        !settledRef.current.has(suggestion.name),
    );
    // 先同步登记 promise 再返回：effect 重入或下一次结果都不会重复安装。
    for (const suggestion of candidates) {
      settledRef.current.set(suggestion.name, installOne(suggestion));
    }
  }, [enabled, installOne, installer, result]);

  const retry = useCallback(
    (name: string) => {
      const suggestion = optionsRef.current.result?.capabilitySuggestions.find(
        (entry) => entry.kind === "skill" && entry.name === name,
      );
      if (!suggestion) return;
      settledRef.current.delete(name);
      settledRef.current.set(name, installOne(suggestion));
    },
    [installOne],
  );

  const remove = useCallback(async (name: string): Promise<void> => {
    const current = optionsRef.current;
    const installer = current.install;
    if (!installer) return;
    setRemovingSkill(name);
    try {
      const listing = await installer.list({
        workspacePath: current.workspacePath,
        ...(current.workspaceIdentity
          ? { workspaceIdentity: current.workspaceIdentity }
          : {}),
      });
      const target = listing.skills.find((skill) => skill.name === name);
      if (!target) throw new Error(`skill not found: ${name}`);
      await installer.deleteSkill({
        workspacePath: current.workspacePath,
        ...(current.workspaceIdentity
          ? { workspaceIdentity: current.workspaceIdentity }
          : {}),
        skillId: target.id,
      });
      // 幂等标记保留：删除是用户的最终选择，同一增强会话内不再自动装回，
      // 否则 result 对象身份变化会让 effect 重跑并覆盖删除动作。需要恢复时
      // 走市场面板的手动安装。
      setStatuses((previous) => ({ ...previous, [name]: { phase: "removed" } }));
      logger.info("Installed suggested skill removed by user", { name });
      current.onSkillListChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Removing suggested skill failed", { name, error: message });
      setStatuses((previous) => ({
        ...previous,
        [name]: { phase: "error", error: message },
      }));
    } finally {
      setRemovingSkill(null);
    }
  }, []);

  return { statuses, retry, remove, removingSkill };
}
