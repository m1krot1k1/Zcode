/**
 * 键盘行为插件：Enter 发送，Shift+Enter 换行，并处理作用域改绑键位与历史快捷键分发。
 *
 * 用 COMMAND_PRIORITY_HIGH 截获 Enter 按键，
 * 阻止 Lexical 默认的段落插入行为。
 */
import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
} from "lexical";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "@/shortcuts/composerShortcuts.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { getEditorMarkdown, resetEditor } from "@/lexical-chat-input/editorOperations.js";
import {
  getPromptMentionIdAfterDomSelection,
  selectAfterPromptMentionById,
} from "@/lexical-chat-input/mentionDomSelection.js";
import {
  shouldSubmitLexicalEnter,
  shouldSubmitLexicalModifiedEnter,
  shouldResetLexicalEditorAfterSubmit,
} from "@/lexical-chat-input/submitPredicates.js";
import type { LexicalSubmitResult } from "@/lexical-chat-input/types.js";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

export function KeyboardPlugin({
  onSubmit,
  onModifiedSubmit,
  disabled,
  submitDisabled,
  allowSubmitWhenEmpty,
  enterSubmits,
}: {
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // 作用域改绑层：读生效表的 composer 命令切片；ref 透传避免按键监听重挂。
  const effectiveShortcutBindings = useEffectiveShortcutBindings();
  const composerEffectiveRef = useRef({
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  });
  composerEffectiveRef.current = {
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  };

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        if (disabled) {
          event.preventDefault();
          return true;
        }

        // IME 正在组合中（如中文输入法），不拦截
        if (event.isComposing) {
          return false;
        }

        const text = getEditorMarkdown(editor.getEditorState());

        // 作用域改绑层：用户键位表优先于内置默认。
        // 命中换行 → 放行 Lexical 插段落；命中发送 → 走与主链等价的门禁分支；
        // 未命中 → 落到下方主链（含反转投递 / 修饰组合换行 / 视口门禁）。
        const composerEffective = composerEffectiveRef.current;
        const scopedAction = resolveComposerKeyAction(event, composerEffective);
        if (scopedAction === "newline") {
          return false;
        }
        if (scopedAction === "send") {
          const modifiedScopedEnter = event.shiftKey || event.ctrlKey || event.metaKey;
          // 反转投递开启时带修饰组合让位主链（Ctrl+Enter = 反向 delivery，交付语义比键位更具体）
          if (!(modifiedScopedEnter && onModifiedSubmit)) {
            // 与主链裸 Enter 等价的门禁：无修饰组合受 submitDisabled / 手机视口 enterSubmits；
            // 带修饰组合不受视口门禁（与主链 onModifiedSubmit 路径一致）。
            if (submitDisabled || (!modifiedScopedEnter && !enterSubmits)) {
              return false;
            }
            event.preventDefault();
            if (
              shouldSubmitLexicalEnter({
                allowSubmitWhenEmpty,
                enterSubmits: modifiedScopedEnter ? true : enterSubmits,
                text,
              })
            ) {
              const submitResult = onSubmit(text);
              if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
                resetEditor(editor);
              }
            }
            return true;
          }
        }

        // 主链前置检查：composerSend 已改绑走（生效绑定不含裸 Enter）时，
        // 裸 Enter 不再代表发送，放行 Lexical 换行（"Ctrl+Enter 党"改绑后的预期行为）。
        if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          shouldBareEnterFallThroughToNewline(composerEffective)
        ) {
          return false;
        }

        if (
          !submitDisabled &&
          onModifiedSubmit &&
          shouldSubmitLexicalModifiedEnter({
            allowSubmitWhenEmpty,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            modifiedEnterSubmits: true,
            shiftKey: event.shiftKey,
            text,
          })
        ) {
          event.preventDefault();
          const submitResult = onModifiedSubmit(text);
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
          return true;
        }

        // Shift+Enter，以及未启用反转投递时的 Ctrl/Meta+Enter 继续换行。
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          return false;
        }

        // 当前请求进行中时，输入框仍允许继续编辑草稿，但此时不能再次提交。
        // 之前把状态直接映射成 disabled，导致输入和联想面板一起失效；如果只去掉 disabled，
        // Enter 又会误触发 submit 并清空草稿。这里在 submitDisabled 时把 Enter 退回给 Lexical 处理换行。
        if (submitDisabled || !enterSubmits) {
          return false;
        }

        event.preventDefault();

        if (
          shouldSubmitLexicalEnter({
            allowSubmitWhenEmpty,
            enterSubmits,
            text,
          })
        ) {
          const submitResult = onSubmit(text);
          // 业务层可能拒绝本次提交并要求草稿留在输入框。
          // Enter 键盘层不能无条件 reset，否则即使业务层未发送，用户输入也会被吃掉。
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          return false;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          return false;
        }

        const text = node.getTextContent();
        if (anchor.offset !== 1 || text !== " ") {
          return false;
        }

        const previousSibling = node.getPreviousSibling();
        if (!$isPromptMentionNode(previousSibling)) {
          return false;
        }

        // mention 插入时会自动补一个空格用于继续输入，
        // 之前 Backspace 会先删这个空格，再删 token，用户体感是“要按两次才删掉标签”。
        // 这里在“光标正好位于补位空格后”时，直接一次性删除空格 + mention token。
        event?.preventDefault();
        previousSibling.remove();
        node.remove();
        node.getParent()?.selectEnd();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const handleRootKeyDownCapture = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.key !== "ArrowRight" ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }

      const rootElement = editor.getRootElement();
      if (!rootElement) {
        return;
      }

      const mentionId = getPromptMentionIdAfterDomSelection(rootElement);
      if (!mentionId) {
        return;
      }

      // macOS Option+ArrowRight 会按 DOM 文本做词级跳转，之前会把光标落进
      // mention token 内部的文件名文本；下一次输入时 Lexical 会把 token 当作被替换内容删除。
      // 在 token 左边界显式把 selection 移到 token 后侧，保持 mention 的原子编辑语义。
      event.preventDefault();
      event.stopImmediatePropagation();
      editor.update(
        () => {
          selectAfterPromptMentionById(mentionId);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    // 作用域改绑层·非 Enter 分发（统一开放策略）：KEY_ENTER_COMMAND 只对 Enter
    // 派发，用户把发送/换行绑成非 Enter 键（如 F9）时由 root keydown capture 分发，
    // 否则改绑是死绑定，且裸 Enter 回退换行会让键盘发送能力整体丢失。
    // 非 Enter 物理键不存在手机软键盘误发问题，send 不受 enterSubmits 视口门禁；
    // 与反转投递（仅响应 Ctrl/Meta+Enter）无交集，无需让位。
    const handleNonEnterScopedKeydown = (event: KeyboardEvent) => {
      if (disabled || event.repeat || event.isComposing || event.key === "Enter") {
        return;
      }
      const scopedAction = resolveComposerKeyAction(event, composerEffectiveRef.current);
      if (!scopedAction) {
        return;
      }
      if (scopedAction === "newline") {
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertLineBreak();
          }
        });
        return;
      }
      if (submitDisabled) {
        return;
      }
      event.preventDefault();
      const text = getEditorMarkdown(editor.getEditorState());
      if (shouldSubmitLexicalEnter({ allowSubmitWhenEmpty, enterSubmits: true, text })) {
        const submitResult = onSubmit(text);
        if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
          resetEditor(editor);
        }
      }
    };

    const unregisterRootListener = editor.registerRootListener(
      (rootElement, previousRootElement) => {
        previousRootElement?.removeEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        previousRootElement?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
      },
    );

    return () => {
      unregisterEnter();
      unregisterBackspace();
      unregisterRootListener();
      editor.getRootElement()?.removeEventListener("keydown", handleRootKeyDownCapture, {
        capture: true,
      });
      editor.getRootElement()?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
        capture: true,
      });
    };
  }, [
    allowSubmitWhenEmpty,
    disabled,
    editor,
    enterSubmits,
    onModifiedSubmit,
    onSubmit,
    submitDisabled,
  ]);

  return null;
}
