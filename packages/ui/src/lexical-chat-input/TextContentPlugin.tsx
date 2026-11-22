/**
 * 文本变化插件
 *
 * 直接用 Lexical 自带的 OnChangePlugin 时，第一次从空编辑器输入字符会被内部的
 * `prevEditorState.isEmpty()` 直接跳过，父组件的 input 状态拿不到首字符，发送按钮和输入内容会错位。
 * 这里改成自己监听 update，只在序列化后的 markdown 真正变化时同步，首字符输入也能稳定回传。
 */
import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { recordInputLag } from "@/lib/uiPerfArmsTelemetry.js";
import { getEditorMarkdown } from "@/lexical-chat-input/editorOperations.js";

export function TextContentPlugin({
  onChange,
  taskId,
}: {
  onChange?: (text: string) => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();
  // IME 组合态标记:不直接依赖 editor.isComposing(),因为它在 update listener 同步执行时
  // 是否已反映组合态存在时序不确定性,读不到 true 会把中文/日文长文本组合的高耗时误报成打字卡顿。
  // 改由 compositionstart/compositionend 事件自行维护,稳健可控。
  const composingRef = useRef(false);

  useEffect(() => {
    const handleCompositionStart = () => {
      composingRef.current = true;
    };
    const handleCompositionEnd = () => {
      // compositionend 触发时组合刚结束,但「组合提交」这一拍的 update listener 通常在同一轮
      // 任务里同步执行,若立即置 false,这次高耗时会被误判为打字卡顿。用 queueMicrotask 把置 false
      // 延后到当前同步任务之后,确保组合提交那一拍仍按组合态短路,再恢复正常计入。
      queueMicrotask(() => {
        composingRef.current = false;
      });
    };

    // root 会重挂,用 registerRootListener 在新旧 root 上正确解绑/绑定。
    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("compositionstart", handleCompositionStart);
      previousRootElement?.removeEventListener("compositionend", handleCompositionEnd);
      rootElement?.addEventListener("compositionstart", handleCompositionStart);
      rootElement?.addEventListener("compositionend", handleCompositionEnd);
    });
  }, [editor]);

  useEffect(() => {
    if (!onChange) {
      return;
    }

    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState, tags }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }

        // 输入卡顿计时:包住「全量序列化 + onChange 同步重渲染」这段处理热点。
        const startedAt = performance.now();

        const nextText = getEditorMarkdown(editorState);
        const previousText = getEditorMarkdown(prevEditorState);
        if (nextText === previousText) {
          return;
        }

        onChange(nextText);

        const lagMs = performance.now() - startedAt;
        // 程序化改写与 IME 组合态不算打字卡顿(判定在 recordInputLag 内统一短路)。
        recordInputLag({
          lagMs,
          textLength: nextText.length,
          isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
          isComposing: composingRef.current,
          taskId: taskId ?? undefined,
        });
      },
    );
  }, [editor, onChange, taskId]);

  return null;
}
