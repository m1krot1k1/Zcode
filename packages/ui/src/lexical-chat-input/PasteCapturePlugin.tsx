/**
 * 粘贴捕获插件：长文本转附件后阻断 Lexical 后续 paste command，避免双份内容。
 */
import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { ChatComposerPasteEvent } from "@/lexical-chat-input/types.js";

export function PasteCapturePlugin({
  disabled,
  onPaste,
}: {
  disabled?: boolean;
  onPaste?: (event: ChatComposerPasteEvent) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPaste) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) {
        return;
      }

      const wasDefaultPrevented = event.defaultPrevented;
      onPaste(event);
      if (event.defaultPrevented && !wasDefaultPrevented) {
        // 长文本已经被转成附件后，必须阻断 Lexical 后续 paste command，
        // 否则会出现“附件有了，正文也被插入”的双份内容。
        event.stopImmediatePropagation();
      }
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("paste", handlePaste, {
        capture: true,
      });
      rootElement?.addEventListener("paste", handlePaste, { capture: true });
    });
  }, [disabled, editor, onPaste]);

  return null;
}
