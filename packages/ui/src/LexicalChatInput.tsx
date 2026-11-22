/**
 * LexicalChatInput — 基于 Lexical 的聊天输入框
 *
 * 基于 Lexical 的聊天输入框，支持 slash command 和 mention tag。
 * - Enter 发送，Shift+Enter 换行
 * - 支持 IME 输入
 * - 自动高度（默认显示 3 行，超出后滚动）
 * - disabled 状态
 * - 通过 SlashCommandPlugin / MentionPlugin 支持 `/` / `@` 的触发面板
 *
 * 独立输入展示壳，不承载会话编排逻辑，仅做三处适配：
 * 1. useChatViewActiveTaskProvider 来自 @/v4/activeTaskProvider.js（配置面读取）；
 * 2. ChatComposerPasteEvent 收口为本文件导出的结构类型；
 * 3. mention 面板用 enableMentionPanel 控制；slash command 始终读取 CLI workspace catalog。
 *
 * 零件拆分在 `lexical-chat-input/`：编辑器命令式操作、键盘/历史/粘贴等插件与首帧打点
 * 各自独立；本文件只保留 LexicalComposer 编排和对外公开入口，导出面保持不变。
 */
import { PromptClipboardPlugin } from "@/mentions/PromptClipboardPlugin.js";
import { resolveMobileInputTextSizeClassName } from "@/lib/mobileTextInput.js";
import { useCallback, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { SlashCommandPlugin } from "./SlashCommandPlugin.js";
import { MentionPlugin } from "./mentions/MentionPlugin.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import { PromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import { logger } from "./logger.js";
import { KeyboardPlugin } from "@/lexical-chat-input/KeyboardPlugin.js";
import { TextContentPlugin } from "@/lexical-chat-input/TextContentPlugin.js";
import { PromptHistoryPlugin } from "@/lexical-chat-input/PromptHistoryPlugin.js";
import { LeadingChineseSlashAliasPlugin } from "@/lexical-chat-input/LeadingChineseSlashAliasPlugin.js";
import { PasteCapturePlugin } from "@/lexical-chat-input/PasteCapturePlugin.js";
import {
  EditablePlugin,
  EditorApiPlugin,
  E2ELexicalInputBridgePlugin,
} from "@/lexical-chat-input/editorPlugins.js";
import { useLexicalChatInputReadyLog } from "@/lexical-chat-input/useLexicalChatInputReadyLog.js";
import { ChatGhostAutocomplete } from "@/lexical-ghost-autocomplete/ChatGhostAutocomplete.js";
import { GhostTextNode } from "@/lexical-ghost-autocomplete/GhostTextNode.js";
import type { LexicalChatInputProps } from "@/lexical-chat-input/types.js";

const EDITOR_THEME = {
  paragraph: "m-0",
};

export function LexicalChatInput({
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  onSubmit,
  onModifiedSubmit,
  onChange,
  onFocus,
  triggerPanelContainer,
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  inputTestId,
  editorApiRef,
  promptHistory = [],
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  onWhiteboardMentionSelected,
  onPaste,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel = true,
}: LexicalChatInputProps) {
  const activeTaskProvider = useChatViewActiveTaskProvider(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  useLexicalChatInputReadyLog({
    activeTaskProvider,
    disabled,
    promptHistoryLength: promptHistory.length,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  });
  const handleSubmit = useCallback(
    (text: string) => {
      const submitResult = onSubmit(text);
      requestAnimationFrame(() => {
        editorApiRef?.current?.focus();
      });
      return submitResult;
    },
    [editorApiRef, onSubmit],
  );
  // Lexical 的 ContentEditable props 是一个互斥联合类型，
  // aria-placeholder 一旦出现就要求 placeholder 同时存在。
  // 之前直接写三元 JSX，TypeScript 在合并两条分支时没有正确保留这组联动约束，导致误报缺少 placeholder。
  const contentEditableProps: React.ComponentProps<typeof ContentEditable> = placeholder
    ? {
        "aria-placeholder": placeholder,
        placeholder: (
          <div
            className={`pointer-events-none absolute left-0 top-0 ${compactPlaceholder ? "line-clamp-2" : ""} ${resolveMobileInputTextSizeClassName(
              {
                avoidIosInputFocusZoom,
              },
            )} text-foreground-subtlest`}
          >
            {placeholder}
          </div>
        ),
      }
    : {
        placeholder: null,
      };

  const contentEditable = (
    <ContentEditable
      // Bugfix: mention node 使用固定行高的 inline-flex chip，普通正文如果继承浏览器 normal line-height，
      // 在 token 后继续输入文字时会按不同 line box 计算基线；这里显式收口正文行高，并允许手机远控使用 16px 防止 iOS 聚焦放大。
      className={`min-h-10 max-h-40 overflow-y-auto ${resolveMobileInputTextSizeClassName({
        avoidIosInputFocusZoom,
      })} text-foreground outline-none`}
      data-testid={inputTestId}
      onFocus={onFocus}
      {...contentEditableProps}
    />
  );

  // Ghost-подсказка должна уступать Tab открытой панели `/` или `@`.
  // Флаг держим в ref, чтобы не пересоздавать команды плагина на каждом ре-рендере.
  const triggerPanelOpenRef = useRef(false);
  const isTriggerPanelOpen = useCallback(() => triggerPanelOpenRef.current, []);

  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: EDITOR_THEME,
      nodes: [PromptMentionNode, GhostTextNode],
      // LexicalComposer initialConfig 每次 render 新建会让输入区子树被记录为 props 变化；
      // 配置内容本身是静态的，固定引用能避免无关状态更新触发 composer 子树冒泡。
      onError: (error: Error) => {
        logger.error("[LexicalChatInput] editor error:", error);
      },
    }),
    [],
  );

  return (
    <div className="relative flex-1">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative">
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
          <HistoryPlugin />
          <PromptClipboardPlugin />
          <TextContentPlugin onChange={onChange} taskId={taskId} />
          <KeyboardPlugin
            onSubmit={handleSubmit}
            onModifiedSubmit={onModifiedSubmit}
            disabled={disabled}
            submitDisabled={submitDisabled}
            allowSubmitWhenEmpty={allowSubmitWhenEmpty}
            enterSubmits={enterSubmits}
          />
          <PromptHistoryPlugin entries={promptHistory} disabled={disabled} />
          <EditablePlugin editable={!disabled} />
          <E2ELexicalInputBridgePlugin inputTestId={inputTestId} />
          <EditorApiPlugin editorApiRef={editorApiRef} />
          <LeadingChineseSlashAliasPlugin disabled={disabled} />
          <PasteCapturePlugin disabled={disabled} onPaste={onPaste} />
          <ChatGhostAutocomplete
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            isTriggerPanelOpen={isTriggerPanelOpen}
            disabled={disabled}
          />
        </div>
        <SlashCommandPlugin
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={skillCatalogSessionId ?? taskId}
          provider={activeTaskProvider}
          container={triggerPanelContainer}
          disabled={disabled}
          excludedCommandNames={excludedSlashCommandNames}
          appCommands={appSlashCommands}
          onPanelOpenChange={(open) => {
            triggerPanelOpenRef.current = open;
          }}
        />
        {enableMentionPanel ? (
          <MentionPlugin
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            provider={activeTaskProvider}
            container={triggerPanelContainer}
            disabled={disabled}
            onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          />
        ) : null}
      </LexicalComposer>
    </div>
  );
}

/** 简单的错误边界 */
function LexicalErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export type { ChatComposerPasteEvent, LexicalChatInputHandle } from "./lexical-chat-input/types.js";
export {
  shouldResetLexicalEditorAfterSubmit,
  shouldSubmitLexicalEnter,
  shouldSubmitLexicalModifiedEnter,
} from "./lexical-chat-input/submitPredicates.js";
export {
  insertEditorMention,
  prependEditorMentionIfMissing,
  replaceEditorWithMention,
} from "./lexical-chat-input/editorOperations.js";
