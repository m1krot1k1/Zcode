/**
 * 终端设置分组的视图模型：字体族草稿态与集成终端 shell 选项投影。
 *
 * 从 `GeneralSectionContent` 内联逻辑原样提取，hook 调用顺序与派生计算顺序不变；
 * 视图层（`GeneralSettingsGroups`）只负责渲染。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
} from "@zcode/shared";

export interface UseTerminalSettingsParams {
  terminalFontFamily: string;
  integratedTerminalShell: IntegratedTerminalShellSelection;
  integratedTerminalShellOptions: IntegratedTerminalShellOption[];
  onTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  onIntegratedTerminalShellChange: (selection: IntegratedTerminalShellSelection) => Promise<void>;
}

export function useTerminalSettings({
  terminalFontFamily,
  integratedTerminalShell,
  integratedTerminalShellOptions,
  onTerminalFontFamilyChange,
  onIntegratedTerminalShellChange,
}: UseTerminalSettingsParams) {
  // 部分 SSR 单测会用精简 props 直接渲染本组件，新增终端设置项后旧 helper 未必同步传值。
  // 这里把运行时缺省值兜到“继承系统 profile”，避免 undefined.trim() 把无关测试打断。
  const [localTerminalFontFamily, setLocalTerminalFontFamily] = useState(terminalFontFamily);

  useEffect(() => {
    setLocalTerminalFontFamily(terminalFontFamily);
  }, [terminalFontFamily]);

  const normalizedTerminalFontFamily = localTerminalFontFamily.trim();
  const isTerminalFontFamilyDirty = normalizedTerminalFontFamily !== terminalFontFamily;
  const integratedTerminalShellValue =
    integratedTerminalShell.mode === "shell" ? integratedTerminalShell.id : "auto";
  const selectedIntegratedTerminalShellOption =
    integratedTerminalShell.mode === "shell"
      ? (integratedTerminalShellOptions.find(
          (option) => option.id === integratedTerminalShell.id,
        ) ?? {
          dialect: integratedTerminalShell.dialect,
          id: integratedTerminalShell.id,
          label: integratedTerminalShell.label,
          path: integratedTerminalShell.path,
          source: "system" as const,
        })
      : undefined;
  const visibleIntegratedTerminalShellOptions = selectedIntegratedTerminalShellOption
    ? [
        selectedIntegratedTerminalShellOption,
        ...integratedTerminalShellOptions.filter(
          (option) => option.id !== selectedIntegratedTerminalShellOption.id,
        ),
      ]
    : integratedTerminalShellOptions;

  const handleTerminalFontFamilySave = useCallback(async () => {
    await onTerminalFontFamilyChange(normalizedTerminalFontFamily);
  }, [normalizedTerminalFontFamily, onTerminalFontFamilyChange]);

  const handleIntegratedTerminalShellChange = useCallback(
    async (value: string) => {
      if (value === "auto") {
        await onIntegratedTerminalShellChange({ mode: "auto" });
        return;
      }
      const option = visibleIntegratedTerminalShellOptions.find(
        (candidate) => candidate.id === value,
      );
      if (!option) {
        return;
      }
      await onIntegratedTerminalShellChange({
        mode: "shell",
        dialect: option.dialect,
        id: option.id,
        label: option.label,
        path: option.path,
      });
    },
    [onIntegratedTerminalShellChange, visibleIntegratedTerminalShellOptions],
  );

  return {
    localTerminalFontFamily,
    setLocalTerminalFontFamily,
    isTerminalFontFamilyDirty,
    integratedTerminalShellValue,
    visibleIntegratedTerminalShellOptions,
    handleTerminalFontFamilySave,
    handleIntegratedTerminalShellChange,
  };
}

export type TerminalSettingsController = ReturnType<typeof useTerminalSettings>;
