/**
 * 编辑器生命周期插件：可编辑状态、E2E 测试桥与外部命令式 API。
 *
 * 三者都只依赖 Lexical editor 实例，从 LexicalChatInput 壳中拆出以控制单文件体量。
 */
import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_LOW, FOCUS_COMMAND } from "lexical";
import {
  applyEditorVoiceDictation,
  beginEditorVoiceDictation,
  cancelEditorVoiceDictation,
  getEditorMarkdown,
  replaceEditorStateJson,
  replaceEditorText,
  replaceEditorTextWithPluginMentions,
} from "@/lexical-chat-input/editorOperations.js";
import {
  appendEditorFileMention,
  appendEditorPlainText,
  insertEditorMention,
  prependEditorMentionIfMissing,
  replaceEditorWithMention,
  replaceEditorWithSkillMention,
  replaceEditorWithSlashCommandMention,
  resetEditor,
} from "@/lexical-chat-input/editorOperations.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { LexicalChatInputHandle } from "@/lexical-chat-input/types.js";
import { setActiveLexicalChatInput } from "@/lexical-chat-input/activeInput.js";

/** 编辑器可编辑状态控制插件 */
export function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

export function E2ELexicalInputBridgePlugin({ inputTestId }: { inputTestId?: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!inputTestId || typeof document === "undefined") {
      return;
    }

    const bridge = {
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
    };

    let attachedInput: HTMLElement | null = null;
    const detachBridge = (input: HTMLElement | null) => {
      if (
        input &&
        (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E === bridge
      ) {
        delete (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E;
      }
      input?.removeAttribute("data-e2e-lexical-bridge");
    };
    const attachBridge = (input: HTMLElement | null) => {
      if (attachedInput && attachedInput !== input) {
        detachBridge(attachedInput);
      }
      attachedInput = input;
      if (!input) {
        return;
      }

      // E2E 需要驱动真实 Lexical state；只改 DOM contenteditable 会绕过 editor update，
      // 容易把文本误打到主输入框，导致测试结论和产品行为脱节。
      Object.defineProperty(input, "__zcodeLexicalInputE2E", {
        configurable: true,
        value: bridge,
      });
      input.setAttribute("data-e2e-lexical-bridge", "ready");
    };

    const resolveInput = (rootElement: HTMLElement | null) => {
      if (rootElement?.getAttribute("data-testid") === inputTestId) {
        return rootElement;
      }
      return document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    };

    let retryTimer: number | null = null;
    const tryAttachBridge = () => {
      const nextInput = resolveInput(editor.getRootElement());
      attachBridge(nextInput);
      if (nextInput && retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement !== rootElement) {
        detachBridge(previousRootElement);
      }
      // E2E bridge 之前只在 effect 里查询一次 DOM。
      // 编辑器 root 如果比插件晚挂载或被 Lexical 重挂载，bridge 会永久缺失。
      attachBridge(resolveInput(rootElement));
    });

    tryAttachBridge();
    // edit 场景里 ChatPromptEditor 的 initialValue 回填、Lexical root 注册、
    // React DOM 提交顺序可能跨多个帧。短轮询只负责补挂测试 bridge，不参与产品行为。
    retryTimer = window.setInterval(tryAttachBridge, 100);

    return () => {
      unregisterRoot();
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
      }
      detachBridge(attachedInput);
    };
  }, [editor, inputTestId]);

  return null;
}

export function EditorApiPlugin({
  editorApiRef,
  onCancelGhostAutocomplete,
}: {
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  onCancelGhostAutocomplete?: () => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editorApiRef) {
      return;
    }

    editorApiRef.current = {
      clear: () => resetEditor(editor),
      focus: () => editor.focus(),
      ...(onCancelGhostAutocomplete ? { cancelGhostAutocomplete: onCancelGhostAutocomplete } : {}),
      getEditorState: () => editor.getEditorState(),
      getMarkdown: () => getEditorMarkdown(editor.getEditorState()),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      appendText: (text: string) => appendEditorPlainText(editor, text),
      beginVoiceDictation: () => beginEditorVoiceDictation(editor),
      applyVoiceDictation: (text: string, final = false) =>
        applyEditorVoiceDictation(editor, text, final),
      cancelVoiceDictation: () => cancelEditorVoiceDictation(editor),
      appendFileMention: (
        label: string,
        value: string,
        markdown: string,
        data?: MentionItemData,
        trailingText = " ",
      ) => appendEditorFileMention(editor, label, value, markdown, data, trailingText),
      insertMention: (mention, selectionState) =>
        insertEditorMention(editor, mention, selectionState),
      prependMentionIfMissing: (mention) => prependEditorMentionIfMissing(editor, mention),
      setMention: (mention, trailingText) =>
        replaceEditorWithMention(editor, mention, trailingText),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
      setSkillMention: (skillName: string, markdown = `$${skillName}`, trailingText = " ") =>
        replaceEditorWithSkillMention(editor, skillName, markdown, trailingText),
      setSlashCommandMention: (
        commandName: string,
        markdown = `/${commandName}`,
        trailingText = " ",
      ) => replaceEditorWithSlashCommandMention(editor, commandName, markdown, trailingText),
    };

    setActiveLexicalChatInput(editorApiRef.current);
    const unregisterFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        if (editorApiRef.current) setActiveLexicalChatInput(editorApiRef.current);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterFocus();
      editorApiRef.current = null;
      setActiveLexicalChatInput(null);
    };
  }, [editor, editorApiRef, onCancelGhostAutocomplete]);

  return null;
}
