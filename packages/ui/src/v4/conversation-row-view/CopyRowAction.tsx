import { memo, useCallback, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { MessageAction } from "@/components/ai-elements/message.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";

/** 复制行文本：图标 ghost 按钮 + 1200ms 打勾态（对齐旧版 message copy）。
 *  label/tooltip 必须由调用方传入 i18n 文案，禁止硬编码语言。 */
export const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});
