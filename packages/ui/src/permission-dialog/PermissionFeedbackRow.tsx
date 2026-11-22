import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { ZCodePermissionOption } from "@zcode/shared";
import { MAX_PERMISSION_FEEDBACK_CHARS } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveMobileInputTextSizeClassName } from "@/lib/mobileTextInput.js";

export interface PermissionFeedbackRowProps {
  feedback: string;
  feedbackIndex: number;
  feedbackOption: ZCodePermissionOption;
  refine: boolean;
  isSelected: boolean;
  avoidIosInputFocusZoom: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * 反馈行：普通确认窗对应 Deny（拒绝 + 反馈），工作流确认窗对应 Refine
 * （拒绝 + 修改意见升级为真实 user message）。两种确认窗共用同一行输入，只换应答目标与文案。
 */
export function PermissionFeedbackRow({
  feedback,
  feedbackIndex,
  feedbackOption,
  refine,
  isSelected,
  avoidIosInputFocusZoom,
  inputRef,
  onChange,
  onFocus,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
}: PermissionFeedbackRowProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      onClick={(event) => {
        if (event.target !== inputRef.current) {
          inputRef.current?.focus();
        }
      }}
      className={cn(
        "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
        isSelected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span
        className={cn(
          // 匹配 textarea 的首行行高和 1px 边框；手机输入行高不同，但序号字号不变。
          "mt-px w-5 shrink-0 self-start text-ui-base font-medium md:leading-relaxed",
          avoidIosInputFocusZoom ? "leading-6" : "leading-5",
          isSelected ? "text-foreground" : "text-foreground-subtlest",
        )}
      >
        {feedbackIndex + 1}.
      </span>
      <Textarea
        ref={inputRef}
        rows={1}
        wrap="soft"
        value={feedback}
        maxLength={MAX_PERMISSION_FEEDBACK_CHARS}
        // Refine 行的文案按稳定 optionId 本地化：协议里的 name 是服务端英文兜底。
        aria-label={intl.formatMessage({
          id: refine ? "chat.permission.workflow.refine" : "chat.permission.feedback.ariaLabel",
        })}
        placeholder={intl.formatMessage({
          id: refine
            ? "chat.permission.workflow.refine.placeholder"
            : "chat.permission.feedback.placeholder",
        })}
        data-permission-feedback-option={feedbackOption.optionId}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
        className={cn(
          // Bugfix: 拒绝反馈自动换行，但限制为 5 行并在输入框内滚动，避免窄屏遮住权限选项和确认按钮。
          "h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 font-medium shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0",
          resolveMobileInputTextSizeClassName({ avoidIosInputFocusZoom }),
        )}
      />
    </div>
  );
}
