/**
 * 中文顿号归一插件：仅在真实手输且位于全文开头时把 `、` 替换成 `/`。
 */
import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { STANDARD_SLASH_TRIGGER } from "@/lexical-chat-input/constants.js";
import { shouldNormalizeLeadingChineseSlashAliasInput } from "@/lexical-chat-input/submitPredicates.js";

function isCollapsedSelectionAtEditorStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }

  const [startPoint] = selection.getStartEndPoints() ?? [];
  if (!startPoint || startPoint.offset !== 0) {
    return false;
  }

  const root = $getRoot();
  const startNode = startPoint.getNode();
  if (startPoint.type === "text") {
    const firstTextNode = root.getAllTextNodes()[0] ?? null;
    return firstTextNode?.is(startNode) ?? root.getTextContentSize() === 0;
  }

  if (startNode.is(root)) {
    return true;
  }

  const firstDescendant = root.getFirstDescendant();
  return firstDescendant?.is(startNode) ?? root.getTextContentSize() === 0;
}

export function LeadingChineseSlashAliasPlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleBeforeInput = (event: InputEvent) => {
      let shouldNormalize = false;
      editor.getEditorState().read(() => {
        shouldNormalize = shouldNormalizeLeadingChineseSlashAliasInput({
          data: event.data,
          inputType: event.inputType,
          isAtEditorStart: isCollapsedSelectionAtEditorStart(),
          isComposing: event.isComposing,
        });
      });

      if (!shouldNormalize) {
        return;
      }

      // 中文输入法下用户在输入框第一位想打 `/` 唤起命令时，
      // 可能会实际输入顿号 `、`。这里只拦截真实手输且位于全文开头的顿号，
      // 立即归一成标准 `/`，避免把顿号扩散成 slash command 的另一套匹配语法。
      event.preventDefault();
      editor.update(
        () => {
          if (!isCollapsedSelectionAtEditorStart()) {
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertText(STANDARD_SLASH_TRIGGER);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("beforeinput", handleBeforeInput as EventListener);
      rootElement?.addEventListener("beforeinput", handleBeforeInput as EventListener);
    });
  }, [disabled, editor]);

  return null;
}
