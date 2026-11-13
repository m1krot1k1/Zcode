import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ElicitationDialogProps } from "./contract.js";
import { ElicitationCollapsedHeader, ElicitationDialogHeader } from "./ElicitationDialogHeader.js";
import { ElicitationFooter } from "./ElicitationFooter.js";
import { ElicitationOptionList } from "./ElicitationOptionList.js";
import { useElicitationDialogController } from "./useElicitationDialogController.js";

export function ElicitationDialog(props: ElicitationDialogProps) {
  // 普通 AskUserQuestion 首次操作会把 autoResolution 从计时态更新为
  // snoozed，投影因此重建 request 对象，但业务 requestId 没变。若按 request/questions
  // 引用重置，本地 questionIndex 和 drafts 会被误清空并跳回第一题。
  // 用 key 把本地表单实例绑定到协议身份：同一请求保留进度，新请求才完整初始化。
  return <ElicitationDialogContent key={props.request.requestId} {...props} />;
}

function ElicitationEmptyState() {
  const { intl } = useZCodeIntl();
  return (
    <p className="px-1 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "chat.elicitation.noQuestions" })}
    </p>
  );
}

function ElicitationDialogContent(props: ElicitationDialogProps) {
  const {
    request,
    questions,
    currentQuestion,
    currentDraft,
    activeOptionIndex,
    isPlanApproval,
    isQuestionExpanded,
    isDialogExpanded,
    countdownSeconds,
    optionRefs,
    customInputRef,
    cardRef,
    customInputCompositionActiveRef,
    titleHeader,
    titleQuestion,
    shouldOfferQuestionCollapse,
    primaryActionMessageId,
    questionProgress,
    canGoPreviousPage,
    canGoNextPage,
    handleCardKeyDown,
    handleOptionKeyDown,
    handleCustomInputKeyDown,
    goPreviousPage,
    goNextPage,
    selectOption,
    updateCustomAnswer,
    submit,
    continueOrSubmit,
    dismiss,
    focusOption,
    toggleQuestionExpanded,
    toggleDialogExpanded,
    expandDialog,
    reportFirstInteraction,
  } = useElicitationDialogController(props);

  return (
    <div className="w-full shrink-0">
      {/* Bugfix: 手机远控视口较短，长问题和多选项会把按钮顶出弹窗；卡片限高后让内容区内部滚动。 */}
      <div
        ref={cardRef}
        tabIndex={activeOptionIndex < 0 ? 0 : -1}
        data-elicitation-dialog-card="true"
        className="relative z-1 flex w-full max-h-[min(72dvh,42rem)] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-xs outline-none"
        onMouseEnter={() => reportFirstInteraction("panelHover")}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div
            data-elicitation-dialog-body="true"
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1",
              !isDialogExpanded ? "max-md:hidden" : undefined,
            )}
          >
            <ElicitationDialogHeader
              origin={request.origin}
              titleHeader={titleHeader}
              titleQuestion={titleQuestion}
              shouldOfferQuestionCollapse={shouldOfferQuestionCollapse}
              isQuestionExpanded={isQuestionExpanded}
              onToggleQuestionExpanded={toggleQuestionExpanded}
              isDialogExpanded={isDialogExpanded}
              onToggleDialogExpanded={toggleDialogExpanded}
              countdownSeconds={countdownSeconds}
              onStopCountdown={() => reportFirstInteraction("countdown")}
              canGoPreviousPage={canGoPreviousPage}
              canGoNextPage={canGoNextPage}
              questionProgress={questionProgress}
              onGoPreviousPage={goPreviousPage}
              onGoNextPage={goNextPage}
            />

            {currentQuestion ? (
              <ElicitationOptionList
                question={currentQuestion}
                draft={currentDraft}
                activeOptionIndex={activeOptionIndex}
                isPlanApproval={isPlanApproval}
                ariaLabel={titleQuestion}
                optionRefs={optionRefs}
                customInputRef={customInputRef}
                compositionActiveRef={customInputCompositionActiveRef}
                onSelectOption={selectOption}
                onFocusOption={focusOption}
                onOptionKeyDown={handleOptionKeyDown}
                onCustomAnswerChange={updateCustomAnswer}
                onCustomInputKeyDown={handleCustomInputKeyDown}
              />
            ) : (
              <ElicitationEmptyState />
            )}
          </div>

          {!isDialogExpanded ? (
            <ElicitationCollapsedHeader
              titleHeader={titleHeader}
              titleQuestion={titleQuestion}
              countdownSeconds={countdownSeconds}
              onStopCountdown={() => reportFirstInteraction("countdown")}
              onExpandDialog={expandDialog}
              questionProgress={questionProgress}
            />
          ) : null}

          <ElicitationFooter
            primaryActionMessageId={primaryActionMessageId}
            onDismiss={dismiss}
            onPrimaryAction={questions.length === 0 ? submit : continueOrSubmit}
          />
        </div>
      </div>
    </div>
  );
}
