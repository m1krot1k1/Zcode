import type { ZCodeElicitationRequest } from "@zcode/shared";
import type { DraftState, NormalizedElicitationQuestion } from "./contract.js";

export function normalizeElicitationQuestions(
  request: ZCodeElicitationRequest,
): NormalizedElicitationQuestion[] {
  const sourceQuestions =
    request.questions && request.questions.length > 0
      ? request.questions
      : [
          {
            question: request.message,
            header: request.header ?? request.message,
            options: request.options,
            ...(request.multiSelect ? { multiSelect: true } : {}),
          },
        ];

  return sourceQuestions.map((question, index) => ({
    key: `${index}:${question.question}`,
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label || option.value,
      description: option.description,
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlanApprovalElicitationRequest(request: ZCodeElicitationRequest): boolean {
  const schema = request.schema;
  return (
    isRecord(schema) && schema.interaction === "plan_approval" && schema.toolName === "ExitPlanMode"
  );
}

export function createInitialElicitationDrafts(
  questions: readonly NormalizedElicitationQuestion[],
  request: ZCodeElicitationRequest,
): DraftState {
  return Object.fromEntries(
    questions.map((question, index) => {
      const draftValues =
        request.answerDrafts?.[`answer_${index}`] ?? request.answerDrafts?.[String(index)] ?? [];
      const optionValues = new Set(question.options.map((option) => option.value));
      const selectedValues = draftValues.filter((value) => optionValues.has(value));
      const customAnswer = draftValues.filter((value) => !optionValues.has(value)).join(", ");
      return [question.key, { selectedValues, customAnswer }];
    }),
  );
}

export function normalizeInitialQuestionIndex(
  request: ZCodeElicitationRequest,
  questions: readonly NormalizedElicitationQuestion[],
) {
  if (questions.length === 0) {
    return 0;
  }
  const index = request.currentQuestionIndex;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return 0;
  }
  return Math.max(0, Math.min(index, questions.length - 1));
}

export function getQuestionOptionCount(question: NormalizedElicitationQuestion | undefined) {
  if (!question) {
    return 0;
  }
  return question.options.length + 1;
}

export function getPreferredActiveOptionIndex(
  question: NormalizedElicitationQuestion | undefined,
  drafts: DraftState,
) {
  if (!question) {
    return 0;
  }
  const draft = drafts[question.key];
  const selectedValue = draft?.selectedValues[0];
  if (selectedValue) {
    const selectedIndex = question.options.findIndex((option) => option.value === selectedValue);
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
  }
  if (draft?.customAnswer.trim()) {
    return question.options.length;
  }
  // 不预选任何选项，避免用户将键盘焦点（bg-hover）误认为"已选中"。
  // 用户必须通过方向键导航或点击才能聚焦选项，聚焦后点继续/提交才会自动补选。
  return -1;
}

export function getQuestionAnswers(
  question: NormalizedElicitationQuestion,
  drafts: DraftState,
): string[] {
  const draft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const customAnswer = draft.customAnswer.trim();
  return [...draft.selectedValues, ...(customAnswer ? [customAnswer] : [])];
}

export function buildElicitationResponseContent(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: DraftState,
): Record<string, unknown> {
  // AskUserQuestion 是可选澄清，不是必填表单。只提交用户真实提供的答案，
  // 避免用空字符串伪造偏好；部分或空 answers 由 Agent 使用最佳判断继续。
  const answers = Object.fromEntries(
    questions.flatMap((question) => {
      const questionAnswers = getQuestionAnswers(question, drafts);
      return questionAnswers.length > 0 ? [[question.question, questionAnswers.join(", ")]] : [];
    }),
  );
  const content: Record<string, unknown> = { answers };

  questions.forEach((question, index) => {
    const questionAnswers = getQuestionAnswers(question, drafts);
    if (questionAnswers.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? questionAnswers : questionAnswers[0];
    }
  });

  // 兼容旧版单题 agent 读取 { answer } 的路径。
  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion) {
    const questionAnswers = getQuestionAnswers(onlyQuestion, drafts);
    if (questionAnswers.length > 0) {
      content.answer = onlyQuestion.multiSelect ? questionAnswers : questionAnswers[0];
    }
  }

  return content;
}

export function updateElicitationDraftsForOption(
  drafts: DraftState,
  question: NormalizedElicitationQuestion,
  optionValue: string,
): DraftState {
  const currentDraft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const nextDraft = question.multiSelect
    ? {
        ...currentDraft,
        selectedValues: currentDraft.selectedValues.includes(optionValue)
          ? currentDraft.selectedValues.filter((value) => value !== optionValue)
          : [...currentDraft.selectedValues, optionValue],
      }
    : { selectedValues: [optionValue], customAnswer: "" };
  return {
    ...drafts,
    [question.key]: nextDraft,
  };
}

export function getElicitationQuestionAdvanceKind(
  questions: readonly NormalizedElicitationQuestion[],
  questionIndex: number,
): "next" | "submit" {
  return questionIndex >= questions.length - 1 ? "submit" : "next";
}
