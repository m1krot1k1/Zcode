import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ArrowUpIcon, BotIcon, SquareIcon } from "lucide-react";
import { TID_V4_COMPOSER_SEND, TID_V4_STOP } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveFollowupModifierTooltip } from "@/v4/composer/followupModeSettings.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { ConversationComposerProps } from "./types.js";

/**
 * 编辑器底部的两簇控件：右下「模型 / 思考深度 / 模式 / 发送或停止」，
 * 左下「模式选择 + CUA + 后台任务」。
 *
 * 两者都在调用方的 useMemo 内构建，依赖变化前保持 JSX 身份，避免每个流式
 * 批次重建 Tooltip / Select 子树。这里只做结构拼装，不持有状态。
 */

type ConfigPicker = V4ComposerConfigPicker | null;
type ModifierTooltip = ReturnType<typeof resolveFollowupModifierTooltip>;
type ModelControlsProps = Parameters<typeof V4ComposerModelControls>[0];
type ComposerUsage = ModelControlsProps["usage"];
type ComposerPhase = ModelControlsProps["phase"];
type BackgroundWorks = Parameters<typeof ConversationBackgroundWorkTrigger>[0]["backgroundWorks"];

export interface SubmitControlInput {
  props: ConversationComposerProps;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  remoteAvailable: boolean;
  isMobileTextInputViewport: boolean;
  modelSelectionState: ModelSelectionState;
  composerPhase: ComposerPhase;
  composerUsage: ComposerUsage;
  composerDraft: V4ComposerDraft;
  disabled: boolean;
  runtimeBlocked: boolean;
  pending: boolean;
  highspeedCard: HighspeedCardSnapshot | null;
  highspeedEntranceAnimated: boolean;
  highspeedPresented: boolean;
  highspeedSweepActive: boolean;
  activeConfigPicker: ConfigPicker;
  handleConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  handleSelectModelTrace: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  showStopControl: boolean;
  stopTooltipTitle: string;
  handleStopClick: () => void;
  resolvedSendTooltipTitle: string;
  resolvedSendTooltipShortcut: string | undefined;
  modifierTooltip: ModifierTooltip;
  sendTooltipOpen: boolean;
  setSendTooltipOpen: (open: boolean) => void;
  canSend: boolean;
  handleSendButtonClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface LeadingActionsInput {
  props: ConversationComposerProps;
  disabled: boolean;
  runtimeBlocked: boolean;
  activeConfigPicker: ConfigPicker;
  handleConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  canStop: boolean;
  backgroundWorks: BackgroundWorks;
}

export function buildSubmitControl(input: SubmitControlInput): ReactNode {
  const {
    props,
    intl,
    remoteAvailable,
    isMobileTextInputViewport,
    modelSelectionState,
    composerPhase,
    composerUsage,
    composerDraft,
    disabled,
    runtimeBlocked,
    pending,
    highspeedCard,
    highspeedEntranceAnimated,
    highspeedPresented,
    highspeedSweepActive,
    activeConfigPicker,
    handleConfigPickerOpenChange,
    handleSelectModelTrace,
    showStopControl,
    stopTooltipTitle,
    handleStopClick,
    resolvedSendTooltipTitle,
    resolvedSendTooltipShortcut,
    modifierTooltip,
    sendTooltipOpen,
    setSendTooltipOpen,
    canSend,
    handleSendButtonClick,
  } = input;
  const {
    draftConfig,
    draftMode = false,
    isWebRemoteControl = false,
    modelSelectionReload,
    modelSelectionRefresh,
    modelSelectionView,
    onRecoverCustomModelSelection,
    onSelectThought,
    onSendCompressionCommand,
    onSetComposerOrchestrationMode,
    onSwitchMode,
    provider,
    sessionId = null,
    workspaceIdentity,
    workspacePath,
  } = props;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {!remoteAvailable ? (
        <span
          data-testid="remote-send-unavailable"
          className="max-w-40 text-right text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage({ id: "remote.conversation.sendUnavailable" })}
        </span>
      ) : null}
      {remoteAvailable ? (
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
          <V4ComposerModelControls
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            modelSelectionView={modelSelectionView}
            modelSelectionState={modelSelectionState}
            modelSelectionReload={modelSelectionReload}
            modelSelectionRefresh={modelSelectionRefresh}
            sessionId={sessionId ?? null}
            phase={composerPhase}
            provider={provider}
            isWebRemoteControl={isWebRemoteControl}
            isMobileViewport={isMobileTextInputViewport}
            draftMode={draftMode}
            draftConfig={draftConfig}
            usage={composerUsage}
            disabled={disabled || runtimeBlocked}
            modelLocked={highspeedCard !== null}
            highspeedPresented={highspeedPresented}
            highspeedEntranceAnimated={highspeedEntranceAnimated}
            highspeedSweepActive={highspeedSweepActive}
            highspeedExpiresAt={highspeedCard?.expiresAt}
            highspeedModel={highspeedCard?.model}
            activeConfigPicker={activeConfigPicker}
            onConfigPickerOpenChange={handleConfigPickerOpenChange}
            onSelectModel={handleSelectModelTrace}
            onSelectThought={onSelectThought}
            onSwitchMode={onSwitchMode}
            onRecoverCustomModelSelection={onRecoverCustomModelSelection}
            onSendCompressionCommand={onSendCompressionCommand}
          />
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={composerDraft.orchestrationMode === "swarm" ? "secondary" : "ghost"}
        aria-pressed={composerDraft.orchestrationMode === "swarm"}
        aria-label={intl.formatMessage({ id: "chat.composer.swarm" })}
        title={intl.formatMessage({
          id: "chat.composer.swarm.description",
        })}
        data-testid="v4-composer-swarm-toggle"
        disabled={disabled || runtimeBlocked || pending || !onSetComposerOrchestrationMode}
        onClick={() =>
          onSetComposerOrchestrationMode?.(composerDraft.orchestrationMode !== "swarm")
        }
        className="gap-1"
      >
        <BotIcon className="size-4" />
        <span>{intl.formatMessage({ id: "chat.composer.swarm" })}</span>
      </Button>
      {showStopControl ? (
        <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
          <Button
            type="button"
            variant="secondary"
            size="icon-md"
            onClick={handleStopClick}
            data-testid={TID_V4_STOP}
            aria-label={stopTooltipTitle}
          >
            <SquareIcon className="size-4 fill-current" />
            <span className="sr-only">{stopTooltipTitle}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        <ControlHintTooltip
          title={resolvedSendTooltipTitle}
          shortcut={resolvedSendTooltipShortcut}
          open={Boolean(modifierTooltip) || sendTooltipOpen}
          onOpenChange={setSendTooltipOpen}
        >
          <Button
            type="submit"
            size="icon-md"
            disabled={!canSend}
            onClick={handleSendButtonClick}
            data-testid={TID_V4_COMPOSER_SEND}
            aria-label={resolvedSendTooltipTitle}
            className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
          >
            {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
            <span className="sr-only">{resolvedSendTooltipTitle}</span>
          </Button>
        </ControlHintTooltip>
      )}
    </div>
  );
}

export function buildLeadingActions(input: LeadingActionsInput): ReactNode {
  const {
    props,
    disabled,
    runtimeBlocked,
    activeConfigPicker,
    handleConfigPickerOpenChange,
    canStop,
    backgroundWorks,
  } = input;
  const {
    draftConfig,
    isWebRemoteControl = false,
    onOpenRunningBackgroundWorks,
    onSwitchMode,
    provider,
    remoteSessionId,
    runningSubagentCount = 0,
    workspaceIdentity,
    workspacePath,
  } = props;
  const backgroundWorkOpenTarget = props.backgroundWorkOpenTarget ?? "panel";
  return (
    <>
      <V4ComposerModeSwitch
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        provider={provider}
        draftConfig={draftConfig}
        disabled={disabled || runtimeBlocked}
        activeConfigPicker={activeConfigPicker}
        onConfigPickerOpenChange={handleConfigPickerOpenChange}
        onSwitchMode={onSwitchMode}
      />
      {/* Bug 原因：附件画廊 rebase 曾整段覆盖 leadingActions，误删 staging 的 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
      <V4ComposerCuaEntry
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId}
        isWebRemoteControl={isWebRemoteControl}
        currentSessionBusy={canStop}
      />
      <ConversationBackgroundWorkTrigger
        backgroundWorks={backgroundWorks}
        runningSubagentCount={runningSubagentCount}
        onOpen={onOpenRunningBackgroundWorks}
        openTarget={backgroundWorkOpenTarget}
      />
    </>
  );
}
