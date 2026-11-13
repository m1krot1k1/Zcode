/**
 * 提示词历史浏览插件：输入为空或已在历史浏览态时接管上下方向键。
 *
 * 历史回填使用专用 HISTORY_NAVIGATION_UPDATE_TAG，避免 slash 面板把回填当作用户输入。
 */
import { useCallback, useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
} from "lexical";
import { HISTORY_NAVIGATION_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { navigatePromptHistory } from "@/lib/promptHistory.js";
import { getEditorMarkdown } from "@/lexical-chat-input/editorOperations.js";

export function PromptHistoryPlugin({
  entries,
  disabled,
}: {
  entries: readonly string[];
  disabled?: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const historyIndexRef = useRef<number | null>(null);
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    if (historyIndexRef.current !== null && entries[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [entries]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        return;
      }

      const currentIndex = historyIndexRef.current;
      if (currentIndex === null) {
        return;
      }

      if (entries[currentIndex] === undefined) {
        historyIndexRef.current = null;
        return;
      }

      if (getEditorMarkdown(editorState) !== entries[currentIndex]) {
        historyIndexRef.current = null;
      }
    });
  }, [editor, entries]);

  const applyHistoryEntry = useCallback(
    (nextIndex: number | null, nextValue: string) => {
      historyIndexRef.current = nextIndex;
      applyingHistoryRef.current = true;
      // 使用专用 HISTORY_NAVIGATION_UPDATE_TAG 而非通用 PROGRAMMATIC_UPDATE_TAG，
      // 使 SlashCommandPlugin 能区分"历史回填"与"用户正在输入 slash 查询"，
      // 防止回填含 / 的历史条目时面板重新打开并以 COMMAND_PRIORITY_CRITICAL 吞掉后续方向键。
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          for (const line of nextValue.split("\n\n")) {
            const paragraph = $createParagraphNode();
            if (line) {
              paragraph.append($createTextNode(line));
            }
            root.append(paragraph);
          }
          root.getLastChild()?.selectEnd();
        },
        { tag: HISTORY_NAVIGATION_UPDATE_TAG },
      );
    },
    [editor],
  );

  const handleHistoryNavigation = useCallback(
    (direction: "up" | "down") => (event: KeyboardEvent | null) => {
      if (!event) return false;

      if (
        disabled ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }

      const text = getEditorMarkdown(editor.getEditorState());
      const currentIndex = historyIndexRef.current;

      // 历史导航只在“空输入”或“已经进入历史浏览态”时接管上下键，
      // 避免抢走多行输入原本的光标移动行为。
      if (currentIndex === null && text.length > 0) {
        return false;
      }

      const result = navigatePromptHistory(entries, currentIndex, direction);
      if (!result.shouldHandle) {
        return false;
      }

      event.preventDefault();
      applyHistoryEntry(result.nextIndex, result.nextValue);
      return true;
    },
    [applyHistoryEntry, disabled, editor, entries],
  );

  useEffect(() => {
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleHistoryNavigation("up"),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleHistoryNavigation("down"),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterUp();
      unregisterDown();
    };
  }, [editor, handleHistoryNavigation]);

  return null;
}
