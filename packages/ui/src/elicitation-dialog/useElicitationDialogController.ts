import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildElicitationResponseContent,
  createInitialElicitationDrafts,
  getElicitationQuestionAdvanceKind,
  getPreferredActiveOptionIndex,
  getQuestionAnswers,
  getQuestionOptionCount,
  isPlanApprovalElicitationRequest,
  normalizeElicitationQuestions,
  normalizeInitialQuestionIndex,
  updateElicitationDraftsForOption,
} from "./answers.js";
import {
  PLAN_APPROVAL_APPROVE_VALUE,
  type AnswerDraft,
  type DraftState,
  type ElicitationAutoResolutionSnoozeSource,
  type ElicitationDialogProps,
  type NormalizedElicitationQuestion,
} from "./contract.js";
import { useElicitationCountdownSeconds } from "./countdown.js";
import { resolveElicitationCustomInputKeyAction } from "./customInputKeyAction.js";

/**
 * Elicitation 表单的唯一状态所有者：题目索引、选项草稿、焦点与键盘语义都在这里。
 * 视图组件只消费返回值，拆分后仍保持原有的 hook 顺序与行为。
 */
export function useElicitationDialogController({
  request,
  autoResolution,
  onRespond,
  onFirstInteraction,
  initialFormDraft,
  onFormDraftChange,
}: ElicitationDialogProps) {
  const { intl } = useZCodeIntl();
  const questions = useMemo(() => normalizeElicitationQuestions(request), [request]);
  const [questionIndex, setQuestionIndex] = useState(
    () => initialFormDraft?.questionIndex ?? normalizeInitialQuestionIndex(request, questions),
  );
  const [activeOptionIndex, setActiveOptionIndex] = useState(() =>
    isPlanApprovalElicitationRequest(request) ? 0 : -1,
  );
  const [drafts, setDrafts] = useState<DraftState>(
    () => initialFormDraft?.drafts ?? createInitialElicitationDrafts(questions, request),
  );
  const [isQuestionExpanded, setIsQuestionExpanded] = useState(false);
  const [isDialogExpanded, setIsDialogExpanded] = useState(true);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const customInputRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const customInputCompositionActiveRef = useRef(false);
  const firstInteractionReportedRef = useRef(false);
  const countdownSeconds = useElicitationCountdownSeconds(autoResolution);

  useEffect(() => {
    onFormDraftChange?.(request.requestId, { questionIndex, drafts });
  }, [drafts, onFormDraftChange, questionIndex, request.requestId]);

  const reportFirstInteraction = useCallback(
    (source: ElicitationAutoResolutionSnoozeSource) => {
      if (firstInteractionReportedRef.current) return;
      firstInteractionReportedRef.current = true;
      let request: boolean | void | Promise<boolean | void>;
      try {
        request = onFirstInteraction?.(source);
      } catch {
        firstInteractionReportedRef.current = false;
        return;
      }
      void Promise.resolve(request)
        .then((accepted) => {
          if (accepted === false) firstInteractionReportedRef.current = false;
        })
        .catch(() => {
          firstInteractionReportedRef.current = false;
        });
    },
    [onFirstInteraction],
  );

  useEffect(() => {
    setIsQuestionExpanded(false);
  }, [questionIndex]);

  const currentQuestion = questions[questionIndex];
  const currentDraft = currentQuestion
    ? (drafts[currentQuestion.key] ?? { selectedValues: [], customAnswer: "" })
    : undefined;
  const isPlanApproval = isPlanApprovalElicitationRequest(request);

  useEffect(() => {
    if (getQuestionOptionCount(currentQuestion) === 0 || activeOptionIndex < 0) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      if (activeOptionIndex < (currentQuestion?.options.length ?? 0)) {
        optionRefs.current[activeOptionIndex]?.focus();
        return;
      }
      customInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [activeOptionIndex, currentQuestion]);

  // 初始 activeOptionIndex=-1 时无按钮有焦点。卡片容器自动聚焦后
  // 可接收键盘事件，在容器层捕获 Tab/↓/↑/Enter 启动导航或推进。
  useEffect(() => {
    if (activeOptionIndex < 0) {
      const frameId = requestAnimationFrame(() => {
        cardRef.current?.focus();
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [activeOptionIndex]);

  const updateDraft = useCallback(
    (question: NormalizedElicitationQuestion, updater: (draft: AnswerDraft) => AnswerDraft) => {
      setDrafts((current) => ({
        ...current,
        [question.key]: updater(current[question.key] ?? { selectedValues: [], customAnswer: "" }),
      }));
    },
    [],
  );

  const updateCustomAnswer = useCallback(
    (question: NormalizedElicitationQuestion, value: string) => {
      reportFirstInteraction("answer");
      updateDraft(question, (draft) => ({
        selectedValues: question.multiSelect ? draft.selectedValues : [],
        customAnswer: value,
      }));
    },
    [reportFirstInteraction, updateDraft],
  );

  const submitWithDrafts = useCallback(
    (nextDrafts: DraftState) => {
      const content = buildElicitationResponseContent(questions, nextDrafts);
      onRespond(request.requestId, "accept", content);
    },
    [onRespond, questions, request.requestId],
  );

  const advanceFromQuestion = useCallback(
    (nextDrafts: DraftState) => {
      if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "submit") {
        // 最后一题选完要直接提交；这里用传入的最新草稿，避免 React state
        // 尚未刷新时漏掉最后一次选择。
        submitWithDrafts(nextDrafts);
        return;
      }
      const nextIndex = questionIndex + 1;
      setQuestionIndex(nextIndex);
      const preferred = getPreferredActiveOptionIndex(questions[nextIndex], nextDrafts);
      // Plan mode 切题后默认聚焦第一项，与普通问答的"不预选"策略区分。
      setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
    },
    [questionIndex, questions, submitWithDrafts, isPlanApproval],
  );

  const selectOption = useCallback(
    (question: NormalizedElicitationQuestion, optionValue: string) => {
      reportFirstInteraction("answer");
      const nextDrafts = updateElicitationDraftsForOption(drafts, question, optionValue);
      setDrafts(nextDrafts);
      if (!question.multiSelect) {
        advanceFromQuestion(nextDrafts);
      }
    },
    [advanceFromQuestion, drafts, reportFirstInteraction],
  );

  // 不预选任何选项（activeOptionIndex 初始 -1），消除"焦点即选中"的 UX 混淆。
  // 用户通过方向键/Tab 将焦点移到某选项后点继续/提交，代表意图选择该选项，此时自动补选。
  // 若用户从未按键导航（activeOptionIndex 仍为 -1），提交空答案即为明确的跳过意图。
  const getDraftsWithAutoSelectedOption = useCallback((): DraftState => {
    if (!currentQuestion || currentQuestion.multiSelect) {
      return drafts;
    }
    if (activeOptionIndex < 0) {
      return drafts;
    }
    const draft = drafts[currentQuestion.key];
    const hasAnswer =
      (draft?.selectedValues.length ?? 0) > 0 || (draft?.customAnswer.trim().length ?? 0) > 0;
    if (hasAnswer) {
      return drafts;
    }
    const activeOption = currentQuestion.options[activeOptionIndex];
    if (!activeOption) {
      return drafts;
    }
    return updateElicitationDraftsForOption(drafts, currentQuestion, activeOption.value);
  }, [activeOptionIndex, currentQuestion, drafts]);

  const goBack = useCallback(() => {
    reportFirstInteraction("navigation");
    const nextIndex = Math.max(questionIndex - 1, 0);
    setQuestionIndex(nextIndex);
    const preferred = getPreferredActiveOptionIndex(questions[nextIndex], drafts);
    // Plan mode 返回上一题后默认聚焦第一项。
    setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
  }, [drafts, questionIndex, questions, reportFirstInteraction, isPlanApproval]);

  const submit = useCallback(() => {
    reportFirstInteraction("answer");
    submitWithDrafts(drafts);
  }, [drafts, reportFirstInteraction, submitWithDrafts]);

  const dismiss = useCallback(() => {
    reportFirstInteraction("answer");
    onRespond(request.requestId, "decline");
  }, [onRespond, reportFirstInteraction, request.requestId]);

  const goPreviousPage = useCallback(() => {
    if (questions.length === 0) {
      return;
    }
    goBack();
  }, [goBack, questions.length]);

  const goNextPage = useCallback(() => {
    if (questions.length === 0 || questionIndex >= questions.length - 1) {
      return;
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    questionIndex,
    questions.length,
    reportFirstInteraction,
  ]);

  const continueOrSubmit = useCallback(() => {
    if (
      isPlanApproval &&
      currentQuestion &&
      getQuestionAnswers(currentQuestion, drafts).length === 0
    ) {
      const approveOption = currentQuestion.options.find(
        (option) => option.value === PLAN_APPROVAL_APPROVE_VALUE,
      );
      if (approveOption) {
        // ExitPlanMode 复用普通问答组件，但空答案在计划审批协议里表示拒绝。
        // 主提交按钮没有反馈时必须显式提交 approve，不能继承 AskUserQuestion 的跳过语义。
        selectOption(currentQuestion, approveOption.value);
        return;
      }
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    currentQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    isPlanApproval,
    reportFirstInteraction,
    selectOption,
  ]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      const optionCount = getQuestionOptionCount(currentQuestion);
      if (optionCount === 0) {
        return;
      }
      reportFirstInteraction("navigation");
      setActiveOptionIndex((index) => {
        if (index < 0) return direction > 0 ? 0 : optionCount - 1;
        return (index + direction + optionCount) % optionCount;
      });
    },
    [currentQuestion, reportFirstInteraction],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!currentQuestion) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case " ":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Enter":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          // 多选题 Space 勾选/取消勾选，Enter 确认选择并推进/提交。
          // 单选题 Enter 等同 Space，选中当前选项。
          if (currentQuestion?.multiSelect) {
            continueOrSubmit();
          } else if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Escape":
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
            return;
          }
          dismiss();
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      continueOrSubmit,
      currentQuestion,
      dismiss,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      selectOption,
    ],
  );

  const handleCustomInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      const action = resolveElicitationCustomInputKeyAction({
        key: event.key,
        advanceKind: getElicitationQuestionAdvanceKind(questions, questionIndex),
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        compositionActive: customInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
        isPlanApproval,
        hasPreviousQuestion: questionIndex > 0,
      });
      if (action === "previousOption" || action === "nextOption") {
        event.preventDefault();
        moveSelection(action === "previousOption" ? -1 : 1);
        return;
      }
      if (action) {
        // 原因：空自定义输入框也允许用 Enter / Esc 切题；这仍是明确的题目导航，
        // 不能因为没有触发 onChange 就继续保留自动结束 deadline。
        reportFirstInteraction("navigation");
      }
      if (action === "advance") {
        event.preventDefault();
        if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "next") {
          advanceFromQuestion(drafts);
        }
        return;
      }
      if (action === "submit") {
        event.preventDefault();
        submit();
        return;
      }
      if (action === "previous") {
        event.preventDefault();
        // AskUserQuestion 是多题澄清流；中间题按 Esc 应先返回上一题，
        // 避免用户想改上一题答案时把整个阻塞请求取消掉。
        goBack();
        return;
      }
      if (action === "dismiss") {
        event.preventDefault();
        dismiss();
      }
    },
    [
      advanceFromQuestion,
      dismiss,
      drafts,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      questions,
      reportFirstInteraction,
      submit,
    ],
  );

  const canGoPreviousPage = questions.length > 0 && questionIndex > 0;
  const canGoNextPage = questions.length > 0 && questionIndex < questions.length - 1;

  // activeOptionIndex=-1 时卡片有焦点，键盘事件到达卡片 onKeyDown。
  // Tab/↓/↑ 聚焦选项，Enter 直接推进到下一题（或提交）。
  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (activeOptionIndex >= 0) return; // 按钮已有焦点，由按钮 onKeyDown 处理
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          continueOrSubmit();
          return;
        case "Escape":
          // 初始 activeOptionIndex=-1 时卡片接收焦点，Escape 必须
          // 由卡片层处理，与按钮 onKeyDown 保持一致：非 plan mode 有上题则返回，
          // 否则 dismiss。
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
          } else {
            dismiss();
          }
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      moveSelection,
      continueOrSubmit,
      isPlanApproval,
      questionIndex,
      goBack,
      dismiss,
    ],
  );

  const primaryActionMessageId =
    questions.length === 0 || questionIndex >= questions.length - 1
      ? "chat.elicitation.submit"
      : "chat.elicitation.continue";
  const titleHeader = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.title" })
    : currentQuestion?.header;
  const titleQuestion = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.switchMode.placeholder" })
    : (currentQuestion?.question ?? intl.formatMessage({ id: "chat.elicitation.title" }));
  const shouldOfferQuestionCollapse = titleQuestion.length > 80 || titleQuestion.includes("\n");
  const questionProgress = `${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`;

  const focusOption = (index: number) => setActiveOptionIndex(index);
  const toggleQuestionExpanded = () => setIsQuestionExpanded((expanded) => !expanded);
  const toggleDialogExpanded = () => setIsDialogExpanded((expanded) => !expanded);
  const expandDialog = () => setIsDialogExpanded(true);

  return {
    request,
    questions,
    questionIndex,
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
  };
}
