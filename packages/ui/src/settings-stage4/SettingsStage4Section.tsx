import { useCallback, useMemo, useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import type { AppSettings } from "@zcode/shared";
import { PROMPT_DEPTH_PROFILES, type PromptDepthProfile } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { resolveComputerUseAvailability } from "@/settings/computerUseAvailability.js";
import {
  NumberSettingRow,
  SelectSettingRow,
  SwitchSettingRow,
  TextSettingRow,
} from "./controls.js";
import { matchesStage4Search, mergeStage4Section } from "./contract.js";

/**
 * Единая реактивная панель настроек подсистем Этапа 4 (4.1–4.6).
 *
 * Владелец значений — `settingService`: компонент читает `AppSettings` и пишет
 * патч через `onUpdateSettings`. Второй копии истины нет; вложенные секции
 * отправляются целиком (`mergeStage4Section`), чтобы не потерять скрытые поля.
 */
export interface SettingsStage4SectionProps {
  settings: AppSettings | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  searchQuery?: string;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

export function SettingsStage4Section({
  settings,
  onUpdateSettings,
  searchQuery = "",
  isMacDesktop = false,
  isWindowsDesktop = false,
  isLinuxDesktop = false,
  workspacePath,
  workspaceIdentity,
}: SettingsStage4SectionProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const [clearingLexicon, setClearingLexicon] = useState(false);

  const agentCore = settings?.agentCoreAdvanced;
  const promptEnhancer = settings?.promptEnhancerSettings;
  const chatAutocomplete = settings?.chatAutocompleteSettings;
  const proactiveSuggestion = settings?.proactiveSuggestionSettings;
  const parallelJobs = settings?.parallelJobsSettings;
  const codeIndex = settings?.codeIndexSettings;
  const sandbox = settings?.sandboxSettings;
  const browser = settings?.browserAssistantSettings;

  const computerUseAvailability = useMemo(
    () =>
      resolveComputerUseAvailability({
        isDesktop: true,
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        workspaceIdentity: workspaceIdentity ?? null,
      }),
    [isLinuxDesktop, isMacDesktop, isWindowsDesktop, workspaceIdentity],
  );

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  const patch = useCallback(
    async (next: Partial<AppSettings>) => {
      try {
        await onUpdateSettings(next);
      } catch (error) {
        logger.warn("Stage 4 settings update failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [onUpdateSettings],
  );

  const updateAgentCore = useCallback(
    (next: Partial<NonNullable<typeof agentCore>>) => {
      if (!agentCore) return;
      void patch({ agentCoreAdvanced: mergeStage4Section(agentCore, next) });
    },
    [agentCore, patch],
  );
  const updatePromptEnhancer = useCallback(
    (next: Partial<NonNullable<typeof promptEnhancer>>) => {
      if (!promptEnhancer) return;
      void patch({ promptEnhancerSettings: mergeStage4Section(promptEnhancer, next) });
    },
    [patch, promptEnhancer],
  );
  const updateChatAutocomplete = useCallback(
    (next: Partial<NonNullable<typeof chatAutocomplete>>) => {
      if (!chatAutocomplete) return;
      void patch({ chatAutocompleteSettings: mergeStage4Section(chatAutocomplete, next) });
    },
    [chatAutocomplete, patch],
  );
  const updateProactiveSuggestion = useCallback(
    (next: Partial<NonNullable<typeof proactiveSuggestion>>) => {
      if (!proactiveSuggestion) return;
      void patch({
        proactiveSuggestionSettings: mergeStage4Section(proactiveSuggestion, next),
      });
    },
    [patch, proactiveSuggestion],
  );
  const updateParallelJobs = useCallback(
    (next: Partial<NonNullable<typeof parallelJobs>>) => {
      if (!parallelJobs) return;
      void patch({ parallelJobsSettings: mergeStage4Section(parallelJobs, next) });
    },
    [parallelJobs, patch],
  );
  const updateCodeIndex = useCallback(
    (next: Partial<NonNullable<typeof codeIndex>>) => {
      if (!codeIndex) return;
      void patch({ codeIndexSettings: mergeStage4Section(codeIndex, next) });
    },
    [codeIndex, patch],
  );
  const updateSandbox = useCallback(
    (next: Partial<NonNullable<typeof sandbox>>) => {
      if (!sandbox) return;
      void patch({ sandboxSettings: mergeStage4Section(sandbox, next) });
    },
    [patch, sandbox],
  );
  const updateBrowser = useCallback(
    (next: Partial<NonNullable<typeof browser>>) => {
      if (!browser) return;
      void patch({ browserAssistantSettings: mergeStage4Section(browser, next) });
    },
    [browser, patch],
  );

  const clearLexicon = useCallback(async () => {
    const service = services?.chatAutocompleteService;
    if (!service || !workspacePath) return;
    setClearingLexicon(true);
    try {
      await service.clearLexiconProfile({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
    } catch (error) {
      logger.warn("Clearing user lexicon profile failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setClearingLexicon(false);
    }
  }, [services, workspaceIdentity, workspacePath]);

  if (!settings)
    return <p className="text-ui-base text-foreground-subtle">{t("settings.stage4.loading")}</p>;

  const show = (...keys: string[]) => matchesStage4Search(searchQuery, keys);

  const promptDepth = settings.promptDepth ?? "standard";
  const grouped = [
    show(
      "agent",
      t("settings.stage4.agentReasoning.title"),
      t("settings.stage4.agentReasoning.description"),
    ) && agentCore ? (
      <section key="agentReasoning" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.agentReasoning.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.agentReasoning.description")}
        </p>
        <SettingsGroupCard>
          <SelectSettingRow<PromptDepthProfile>
            label={t("settings.stage4.promptDepth")}
            description={t("settings.stage4.promptDepth.description")}
            value={promptDepth as PromptDepthProfile}
            testId="settings-stage4-prompt-depth"
            options={PROMPT_DEPTH_PROFILES.map((profile) => ({
              value: profile,
              label: t(`settings.stage4.promptDepth.${profile}`),
            }))}
            onChange={(next) => void patch({ promptDepth: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.workingContextCeiling")}
            description={t("settings.stage4.workingContextCeiling.description")}
            value={agentCore.workingContextCeilingTokens}
            min={48_000}
            max={500_000}
            step={1_000}
            unit={t("settings.stage4.tokens")}
            testId="settings-stage4-working-context"
            onChange={(next) => updateAgentCore({ workingContextCeilingTokens: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.autoRepair")}
            description={t("settings.stage4.autoRepair.description")}
            checked={agentCore.enableAutoRepairLoop}
            testId="settings-stage4-auto-repair"
            onChange={(next) => updateAgentCore({ enableAutoRepairLoop: next })}
          />
          {agentCore.enableAutoRepairLoop ? (
            <>
              <NumberSettingRow
                label={t("settings.stage4.autoRepair.iterations")}
                description={t("settings.stage4.autoRepair.iterations.description")}
                value={agentCore.autoRepairLoopMaxIterations}
                min={1}
                max={12}
                testId="settings-stage4-auto-repair-iterations"
                onChange={(next) => updateAgentCore({ autoRepairLoopMaxIterations: next })}
              />
              <NumberSettingRow
                label={t("settings.stage4.autoRepair.elapsed")}
                description={t("settings.stage4.autoRepair.elapsed.description")}
                value={agentCore.autoRepairLoopMaxElapsedMs}
                min={10_000}
                max={900_000}
                step={10_000}
                unit="ms"
                testId="settings-stage4-auto-repair-elapsed"
                onChange={(next) => updateAgentCore({ autoRepairLoopMaxElapsedMs: next })}
              />
            </>
          ) : null}
        </SettingsGroupCard>
      </section>
    ) : null,
    show("enhancer", "prompt", t("settings.stage4.promptEnhancer.title")) && promptEnhancer ? (
      <section key="promptEnhancer" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.promptEnhancer.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.promptEnhancer.description")}
        </p>
        <SettingsGroupCard>
          <SwitchSettingRow
            label={t("settings.stage4.promptEnhancer.enabled")}
            description={t("settings.stage4.promptEnhancer.enabled.description")}
            checked={promptEnhancer.enabled}
            testId="settings-stage4-enhancer-enabled"
            onChange={(next) => updatePromptEnhancer({ enabled: next })}
          />
          <SelectSettingRow
            label={t("settings.stage4.promptEnhancer.style")}
            description={t("settings.stage4.promptEnhancer.style.description")}
            value={promptEnhancer.style}
            testId="settings-stage4-enhancer-style"
            options={[
              {
                value: "structured_engineering",
                label: t("settings.stage4.promptEnhancer.style.structured"),
              },
              { value: "concise_direct", label: t("settings.stage4.promptEnhancer.style.concise") },
              {
                value: "deep_architectural",
                label: t("settings.stage4.promptEnhancer.style.deep"),
              },
            ]}
            onChange={(next) => updatePromptEnhancer({ style: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.promptEnhancer.maxSources")}
            description={t("settings.stage4.promptEnhancer.maxSources.description")}
            value={promptEnhancer.maxContextSources}
            min={0}
            max={5}
            testId="settings-stage4-enhancer-max-sources"
            onChange={(next) => updatePromptEnhancer({ maxContextSources: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.promptEnhancer.codeIndex")}
            description={t("settings.stage4.promptEnhancer.codeIndex.description")}
            checked={promptEnhancer.includeCodeIndexContext}
            onChange={(next) => updatePromptEnhancer({ includeCodeIndexContext: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.promptEnhancer.history")}
            description={t("settings.stage4.promptEnhancer.history.description")}
            checked={promptEnhancer.includeConversationHistory}
            onChange={(next) => updatePromptEnhancer({ includeConversationHistory: next })}
          />
        </SettingsGroupCard>
      </section>
    ) : null,
    show("proactive", "suggestion", t("settings.stage4.proactiveSuggestion.title")) &&
    proactiveSuggestion ? (
      <section key="proactiveSuggestion" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.proactiveSuggestion.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.proactiveSuggestion.description")}
        </p>
        <SettingsGroupCard>
          <SwitchSettingRow
            label={t("settings.stage4.proactiveSuggestion.enabled")}
            description={t("settings.stage4.proactiveSuggestion.enabled.description")}
            checked={proactiveSuggestion.enabled}
            testId="settings-stage4-proactive-suggestion-enabled"
            onChange={(next) => updateProactiveSuggestion({ enabled: next })}
          />
        </SettingsGroupCard>
      </section>
    ) : null,
    show("autocomplete", "ghost", t("settings.stage4.chatAutocomplete.title")) &&
    chatAutocomplete ? (
      <section key="chatAutocomplete" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.chatAutocomplete.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.chatAutocomplete.description")}
        </p>
        <SettingsGroupCard>
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.enabled")}
            description={t("settings.stage4.chatAutocomplete.enabled.description")}
            checked={chatAutocomplete.enabled}
            testId="settings-stage4-autocomplete-enabled"
            onChange={(next) => updateChatAutocomplete({ enabled: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.chatAutocomplete.debounce")}
            description={t("settings.stage4.chatAutocomplete.debounce.description")}
            value={chatAutocomplete.debounceMs}
            min={120}
            max={800}
            step={10}
            unit="ms"
            testId="settings-stage4-autocomplete-debounce"
            onChange={(next) => updateChatAutocomplete({ debounceMs: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.acceptWord")}
            description={t("settings.stage4.chatAutocomplete.acceptWord.description")}
            checked={chatAutocomplete.acceptWordOnArrowRight}
            onChange={(next) => updateChatAutocomplete({ acceptWordOnArrowRight: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.cursorAtEnd")}
            description={t("settings.stage4.chatAutocomplete.cursorAtEnd.description")}
            checked={chatAutocomplete.cursorAtEndOnly}
            onChange={(next) => updateChatAutocomplete({ cursorAtEndOnly: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.history")}
            checked={chatAutocomplete.context.history}
            onChange={(next) =>
              updateChatAutocomplete({
                context: mergeStage4Section(chatAutocomplete.context, { history: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.openFiles")}
            checked={chatAutocomplete.context.openFiles}
            onChange={(next) =>
              updateChatAutocomplete({
                context: mergeStage4Section(chatAutocomplete.context, { openFiles: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.diffs")}
            checked={chatAutocomplete.context.diffs}
            onChange={(next) =>
              updateChatAutocomplete({
                context: mergeStage4Section(chatAutocomplete.context, { diffs: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.codeIndex")}
            checked={chatAutocomplete.context.codeIndex}
            onChange={(next) =>
              updateChatAutocomplete({
                context: mergeStage4Section(chatAutocomplete.context, { codeIndex: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.chatAutocomplete.lexicon")}
            description={t("settings.stage4.chatAutocomplete.lexicon.description")}
            checked={chatAutocomplete.context.userLexicon}
            onChange={(next) =>
              updateChatAutocomplete({
                context: mergeStage4Section(chatAutocomplete.context, { userLexicon: next }),
              })
            }
          />
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="min-w-0">
              <div className="text-ui-base font-medium text-foreground">
                {t("settings.stage4.chatAutocomplete.clearLexicon")}
              </div>
              <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">
                {t("settings.stage4.chatAutocomplete.clearLexicon.description")}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              data-testid="settings-stage4-clear-lexicon"
              disabled={clearingLexicon || !services?.chatAutocompleteService || !workspacePath}
              onClick={() => void clearLexicon()}
              className="gap-1"
            >
              {clearingLexicon ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              {t("settings.stage4.chatAutocomplete.clearLexicon.action")}
            </Button>
          </div>
        </SettingsGroupCard>
      </section>
    ) : null,
    show("parallel", "subagent", t("settings.stage4.parallelJobs.title")) && parallelJobs ? (
      <section key="parallelJobs" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.parallelJobs.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.parallelJobs.description")}
        </p>
        <SettingsGroupCard>
          <NumberSettingRow
            label={t("settings.stage4.parallelJobs.maxSubagents")}
            description={t("settings.stage4.parallelJobs.maxSubagents.description")}
            value={parallelJobs.maxParallelSubagents}
            min={0}
            max={32}
            testId="settings-stage4-max-subagents"
            onChange={(next) => updateParallelJobs({ maxParallelSubagents: next })}
          />
          <SelectSettingRow
            label={t("settings.stage4.parallelJobs.pathConflict")}
            description={t("settings.stage4.parallelJobs.pathConflict.description")}
            value={parallelJobs.pathConflictPolicy}
            testId="settings-stage4-path-conflict"
            options={[
              { value: "block", label: t("settings.stage4.parallelJobs.pathConflict.block") },
              { value: "wave", label: t("settings.stage4.parallelJobs.pathConflict.wave") },
              { value: "worktree", label: t("settings.stage4.parallelJobs.pathConflict.worktree") },
            ]}
            onChange={(next) => updateParallelJobs({ pathConflictPolicy: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.parallelJobs.backgroundFileTasks")}
            description={t("settings.stage4.parallelJobs.backgroundFileTasks.description")}
            checked={parallelJobs.backgroundFileTasks}
            onChange={(next) => updateParallelJobs({ backgroundFileTasks: next })}
          />
        </SettingsGroupCard>
      </section>
    ) : null,
    show("index", "code", t("settings.stage4.codeIndex.title")) && codeIndex ? (
      <section key="codeIndex" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.codeIndex.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.codeIndex.description")}
        </p>
        <SettingsGroupCard>
          <SwitchSettingRow
            label={t("settings.stage4.codeIndex.autoStart")}
            description={t("settings.stage4.codeIndex.autoStart.description")}
            checked={codeIndex.autoStartOnWorkspaceOpen}
            onChange={(next) => updateCodeIndex({ autoStartOnWorkspaceOpen: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.codeIndex.vectorChannel")}
            description={t("settings.stage4.codeIndex.vectorChannel.description")}
            checked={codeIndex.enableVectorChannel}
            testId="settings-stage4-vector-channel"
            onChange={(next) => updateCodeIndex({ enableVectorChannel: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.codeIndex.tokenBudget")}
            description={t("settings.stage4.codeIndex.tokenBudget.description")}
            value={codeIndex.searchResultTokenBudget}
            min={1_000}
            max={12_000}
            step={500}
            unit={t("settings.stage4.tokens")}
            onChange={(next) => updateCodeIndex({ searchResultTokenBudget: next })}
          />
          <TextSettingRow
            label={t("settings.stage4.codeIndex.excluded")}
            description={t("settings.stage4.codeIndex.excluded.description")}
            value={codeIndex.excludedDirectories.join(", ")}
            placeholder="dist, vendor"
            onChange={(next) =>
              updateCodeIndex({
                excludedDirectories: next
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
                  .slice(0, 64),
              })
            }
          />
        </SettingsGroupCard>
      </section>
    ) : null,
    show("sandbox", "computer", "bwrap", t("settings.stage4.sandbox.title")) && sandbox ? (
      <section key="sandbox" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.sandbox.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.sandbox.description")}
        </p>
        <SettingsGroupCard>
          <SelectSettingRow
            label={t("settings.stage4.sandbox.mode")}
            description={t("settings.stage4.sandbox.mode.description")}
            value={sandbox.mode}
            testId="settings-stage4-sandbox-mode"
            options={[
              { value: "bwrap", label: t("settings.stage4.sandbox.mode.bwrap") },
              { value: "seatbelt", label: t("settings.stage4.sandbox.mode.seatbelt") },
              { value: "off", label: t("settings.stage4.sandbox.mode.off") },
            ]}
            onChange={(next) => updateSandbox({ mode: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.sandbox.network")}
            description={t("settings.stage4.sandbox.network.description")}
            checked={sandbox.allowBashNetwork}
            onChange={(next) => updateSandbox({ allowBashNetwork: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.sandbox.timeout")}
            description={t("settings.stage4.sandbox.timeout.description")}
            value={sandbox.commandTimeoutMs}
            min={1_000}
            max={1_800_000}
            step={1_000}
            unit="ms"
            onChange={(next) => updateSandbox({ commandTimeoutMs: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.sandbox.cuaScreenshot")}
            description={
              computerUseAvailability.supported
                ? t("settings.stage4.sandbox.cuaScreenshot.description")
                : t("settings.stage4.sandbox.cuaUnavailable")
            }
            checked={sandbox.cuaPermissions.screenshot}
            disabled={!computerUseAvailability.supported}
            onChange={(next) =>
              updateSandbox({
                cuaPermissions: mergeStage4Section(sandbox.cuaPermissions, { screenshot: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.sandbox.cuaPointer")}
            checked={sandbox.cuaPermissions.pointer}
            disabled={!computerUseAvailability.supported}
            onChange={(next) =>
              updateSandbox({
                cuaPermissions: mergeStage4Section(sandbox.cuaPermissions, { pointer: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.sandbox.cuaKeyboard")}
            checked={sandbox.cuaPermissions.keyboard}
            disabled={!computerUseAvailability.supported}
            onChange={(next) =>
              updateSandbox({
                cuaPermissions: mergeStage4Section(sandbox.cuaPermissions, { keyboard: next }),
              })
            }
          />
          <SwitchSettingRow
            label={t("settings.stage4.sandbox.cuaClipboard")}
            checked={sandbox.cuaPermissions.clipboard}
            disabled={!computerUseAvailability.supported}
            onChange={(next) =>
              updateSandbox({
                cuaPermissions: mergeStage4Section(sandbox.cuaPermissions, { clipboard: next }),
              })
            }
          />
        </SettingsGroupCard>
      </section>
    ) : null,
    show("browser", t("settings.stage4.browser.title")) && browser ? (
      <section key="browser" className="space-y-2">
        <h3 className="text-ui-md font-semibold text-foreground">
          {t("settings.stage4.browser.title")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.stage4.browser.description")}
        </p>
        <SettingsGroupCard>
          <SwitchSettingRow
            label={t("settings.stage4.browser.telemetry")}
            description={t("settings.stage4.browser.telemetry.description")}
            checked={browser.telemetryEnabled}
            onChange={(next) => updateBrowser({ telemetryEnabled: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.browser.screenshotBudget")}
            description={t("settings.stage4.browser.screenshotBudget.description")}
            value={browser.screenshotBudgetBytes}
            min={64 * 1024}
            max={8 * 1024 * 1024}
            step={64 * 1024}
            unit="B"
            onChange={(next) => updateBrowser({ screenshotBudgetBytes: next })}
          />
          <NumberSettingRow
            label={t("settings.stage4.browser.ariaNodes")}
            description={t("settings.stage4.browser.ariaNodes.description")}
            value={browser.ariaSnapshotMaxNodes}
            min={200}
            max={20_000}
            step={100}
            onChange={(next) => updateBrowser({ ariaSnapshotMaxNodes: next })}
          />
          <SwitchSettingRow
            label={t("settings.stage4.browser.autoClose")}
            description={t("settings.stage4.browser.autoClose.description")}
            checked={browser.autoCloseDialogs}
            onChange={(next) => updateBrowser({ autoCloseDialogs: next })}
          />
        </SettingsGroupCard>
      </section>
    ) : null,
  ].filter(Boolean);

  if (grouped.length === 0) {
    return <p className="text-ui-base text-foreground-subtle">{t("settings.stage4.noMatches")}</p>;
  }

  return <div className="space-y-6">{grouped}</div>;
}
