import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  PLAN_APPROVAL_APPROVE_VALUE,
  type AnswerDraft,
  type NormalizedElicitationQuestion,
} from "./contract.js";

export interface ElicitationOptionListProps {
  question: NormalizedElicitationQuestion;
  draft: AnswerDraft | undefined;
  activeOptionIndex: number;
  isPlanApproval: boolean;
  ariaLabel: string;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  customInputRef: RefObject<HTMLTextAreaElement | null>;
  compositionActiveRef: RefObject<boolean>;
  onSelectOption: (question: NormalizedElicitationQuestion, optionValue: string) => void;
  onFocusOption: (index: number) => void;
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onCustomAnswerChange: (question: NormalizedElicitationQuestion, value: string) => void;
  onCustomInputKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ElicitationOptionList({
  question,
  draft,
  activeOptionIndex,
  isPlanApproval,
  ariaLabel,
  optionRefs,
  customInputRef,
  compositionActiveRef,
  onSelectOption,
  onFocusOption,
  onOptionKeyDown,
  onCustomAnswerChange,
  onCustomInputKeyDown,
}: ElicitationOptionListProps) {
  const { intl } = useZCodeIntl();
  const customAnswer = draft?.customAnswer ?? "";
  const isCustomInputSelected = customAnswer.trim().length > 0;
  const isCustomInputActive =
    activeOptionIndex >= 0 && activeOptionIndex === question.options.length;

  return (
    <div className="space-y-3">
      <div
        role={question.multiSelect ? "group" : "listbox"}
        aria-label={ariaLabel}
        className="space-y-1"
      >
        {question.options.map((option, index) => {
          const isSelected = draft?.selectedValues.includes(option.value) === true;
          const isActive = activeOptionIndex >= 0 && activeOptionIndex === index;
          const optionLabel =
            isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
              ? intl.formatMessage({ id: "chat.elicitation.planApproval.approve" })
              : option.label;
          const optionDescription =
            isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
              ? intl.formatMessage({
                  id: "chat.elicitation.planApproval.approveDescription",
                })
              : option.description;
          return (
            <button
              key={option.value}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role={question.multiSelect ? "checkbox" : "option"}
              aria-selected={question.multiSelect ? undefined : isSelected}
              aria-checked={question.multiSelect ? isSelected : undefined}
              tabIndex={isActive || (activeOptionIndex < 0 && index === 0) ? 0 : -1}
              onClick={() => onSelectOption(question, option.value)}
              onFocus={() => onFocusOption(index)}
              onKeyDown={onOptionKeyDown}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-hover",
                isSelected ? "bg-selected" : isActive ? "bg-hover" : "hover:bg-hover",
              )}
            >
              {question.multiSelect ? (
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                    isSelected
                      ? "border-brand bg-brand text-foreground-inverse"
                      : "border-border text-transparent",
                  )}
                >
                  <CheckIcon className="size-3" />
                </span>
              ) : (
                <span
                  className={cn(
                    "w-5 shrink-0 self-center text-ui-base font-medium",
                    isSelected ? "text-foreground" : "text-foreground-subtlest",
                  )}
                >
                  {index + 1}.
                </span>
              )}
              {/* 修复原因：界面字号可动态增大，固定 20px 行高会让大字号文字贴边或裁切。 */}
              <span className="min-w-0 flex-1 text-ui-base leading-normal">
                <span className="text-ui-base font-medium leading-normal text-foreground">
                  {optionLabel}
                </span>
                {optionDescription ? (
                  <span className="ml-2 text-ui-base leading-normal text-foreground-subtle">
                    {optionDescription}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        {/* 原因：计划审批曾隐藏输入序号；所有单选输入行都接续选项编号。 */}
        <div
          key="custom-input"
          role={question.multiSelect ? "checkbox" : undefined}
          aria-checked={question.multiSelect ? isCustomInputSelected : undefined}
          onClick={(event) => {
            if (event.target !== customInputRef.current) {
              customInputRef.current?.focus();
            }
          }}
          className={cn(
            "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
            isCustomInputSelected
              ? "bg-selected"
              : isCustomInputActive
                ? "bg-hover"
                : "hover:bg-hover",
          )}
        >
          {question.multiSelect ? (
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                isCustomInputSelected
                  ? "border-brand bg-brand text-foreground-inverse"
                  : "border-border text-transparent",
              )}
            >
              <CheckIcon className="size-3" />
            </span>
          ) : (
            <span
              className={cn(
                // 与 textarea 首行使用相同行高并让出 1px 边框，避免顶部或整体居中造成错位。
                "mt-px w-5 shrink-0 self-start text-ui-base font-medium leading-normal md:leading-relaxed",
                isCustomInputSelected ? "text-foreground" : "text-foreground-subtlest",
              )}
            >
              {question.options.length + 1}.
            </span>
          )}
          {/* 原因：按内容增高的输入框没有上限会撑满问答卡片；与权限反馈一致，五行后内部滚动。 */}
          <Textarea
            ref={customInputRef}
            rows={1}
            wrap="soft"
            value={customAnswer}
            placeholder={intl.formatMessage({
              id: "chat.elicitation.customAnswer.placeholder",
            })}
            onFocus={() => onFocusOption(question.options.length)}
            onChange={(event) => onCustomAnswerChange(question, event.target.value)}
            onCompositionStart={() => {
              compositionActiveRef.current = true;
            }}
            onCompositionEnd={() => {
              compositionActiveRef.current = false;
            }}
            onKeyDown={onCustomInputKeyDown}
            className="h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 text-ui-base font-medium leading-normal shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0"
          />
        </div>
      </div>
    </div>
  );
}
