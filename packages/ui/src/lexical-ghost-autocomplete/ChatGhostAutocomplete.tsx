import { useEffect, useRef, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { GhostTextAutocompletePlugin } from "./GhostTextAutocompletePlugin.js";
import { useChatAutocomplete } from "./useChatAutocomplete.js";
import {
  DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  type GhostAutocompleteConfig,
} from "./contract.js";

/**
 * Точка подключения ghost-подсказки к композеру.
 *
 * Настройки читаются из единственного владельца (`settingService` через `useSettings`),
 * сервис — из `useServices()`. Компонент ничего не решает сам: он лишь собирает
 * конфигурацию и монтирует плагин, поэтому Desktop, Web и remote Host получают
 * одинаковое поведение без платформенных API.
 */
export interface ChatGhostAutocompleteProps {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  activeFilePath?: string;
  openTabPaths?: readonly string[];
  /** Открыта панель `/` или `@`: плагин обязан уступить клавиши. */
  isTriggerPanelOpen: () => boolean;
  /** Отключить подсказку в конкретном редакторе (inline-режим, disabled и т.п.). */
  disabled?: boolean;
}

export function ChatGhostAutocomplete({
  workspacePath,
  workspaceIdentity,
  sessionId,
  activeFilePath,
  openTabPaths,
  isTriggerPanelOpen,
  disabled = false,
}: ChatGhostAutocompleteProps) {
  const services = useOptionalServices();
  const { settings } = useSettings({ services: services ?? undefined });
  const settingsState = settings?.chatAutocompleteSettings;
  const [config, setConfig] = useState<GhostAutocompleteConfig>(
    DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  );

  useEffect(() => {
    if (!settingsState) {
      setConfig((previous) =>
        previous.enabled ? { ...previous, enabled: false } : previous,
      );
      return;
    }
    setConfig({
      ...DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
      enabled: settingsState.enabled && !disabled,
      baseDebounceMs: settingsState.debounceMs,
      minPrefixChars: settingsState.minPrefixChars,
      cursorAtEndOnly: settingsState.cursorAtEndOnly,
      context: settingsState.context,
      keymap: {
        ...DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.keymap,
        acceptWord: settingsState.acceptWordOnArrowRight ? "ArrowRight" : "off",
      },
      ...(settingsState.modelOverride
        ? { modelSelection: settingsState.modelOverride }
        : {}),
    });
  }, [disabled, settingsState]);

  const service = services?.chatAutocompleteService ?? null;
  const autocomplete = useChatAutocomplete({
    service,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sessionId,
    ...(activeFilePath ? { activeFilePath } : {}),
    ...(openTabPaths ? { openTabPaths } : {}),
    config,
  });

  // Хук живёт между рендерами; плагин держит ссылку, чтобы не пересоздавать команды.
  const autocompleteRef = useRef(autocomplete);
  autocompleteRef.current = autocomplete;

  if (!config.enabled || !service) return null;

  return (
    <GhostTextAutocompletePlugin
      config={config}
      state={autocomplete}
      request={autocomplete.request}
      cancel={autocomplete.cancel}
      reset={autocomplete.reset}
      accept={autocomplete.accept}
      isTriggerPanelOpen={isTriggerPanelOpen}
    />
  );
}
