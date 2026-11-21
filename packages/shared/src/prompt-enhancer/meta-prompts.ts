import type {
  PromptEnhanceFramework,
  PromptEnhanceRequest,
  PromptEnhanceStyle,
} from "./contract.js";
import type { PromptEnhanceClassification } from "./classify.js";

/**
 * Мета-промпты улучшения промптов.
 *
 * Живут в shared, чтобы CLI `/enhance` и Host-сервис использовали один и тот же текст:
 * расхождение формулировок между локальным CLI и Host ломает воспроизводимость eval.
 *
 * Инварианты, общие для всех стилей и обеих целей:
 * - отвечать на языке автора;
 * - не отвечать на сам запрос, а возвращать только улучшенный текст;
 * - сохранять `@`/`$`-упоминания дословно;
 * - не выдумывать требования, которых нет в черновике или в контексте.
 */

/** Общий контракт вывода: один JSON-объект, чтобы разбор не зависел от форматирования. */
const OUTPUT_CONTRACT = `Return exactly one JSON object and nothing else:
{"enhancedText": string, "addedClarifications": string[], "assumptions": [{"text": string, "origin": "draft"|"repository"|"model"}], "capabilitySuggestions": [{"kind": "skill"|"mcp"|"agent"|"plugin", "name": string, "reason": string}]}

Rules for the JSON:
- enhancedText holds the complete improved prompt, ready to paste. Never explain it.
- addedClarifications lists only the concrete constraints you added (goal, scope, files, acceptance criteria). Empty array when you added none.
- assumptions records what you inferred instead of reading it. origin=draft when the draft implies it, repository when the supplied context proves it, model when you guessed.
- capabilitySuggestions is optional and informational. Suggest only a capability that materially improves this task; never install, invoke or claim it is installed. Empty array when none is clearly useful.
- Do not wrap the JSON in markdown fences.`;

const FRAMEWORK_GUIDANCE: Record<PromptEnhanceFramework, string> = {
  oracle: `Use ORACLE: Outcome, Role, Audience, Constraints, Layout, Evidence.
State the outcome first, then the role and audience only when they change the answer, then hard constraints,
the expected layout, and the evidence/verification the agent must return.`,
  rise: `Use RISE: Role, Input, Steps, Execution.
Name the role, list the concrete inputs, order the steps, and define how execution is verified. Keep steps
as work units, not a bureaucratic checklist.`,
  care: `Use CARE: Context, Action, Result, Example.
Give the situation, the action, the result contract, and one compact example of what "good" looks like.
Do not copy an example from the draft if it is unrelated; adapt the supplied context.`,
  tag: `Use TAG: Task, Action, Goal.
Keep the prompt short: one task, one action, one measurable goal. Do not add sections or ceremony.`,
};

const STYLE_GUIDANCE: Record<PromptEnhanceStyle, string> = {
  structured_engineering: `Structure the prompt as: Goal, Relevant code/areas, Constraints, Acceptance criteria.
Keep it as tight as the request allows. One short paragraph per section; no filler sentences.`,
  concise_direct: `Compress aggressively. Keep the author's intent, drop redundancy, and prefer imperative sentences.
Do not add sections the draft does not need. Never invent requirements to make it look thorough.`,
  deep_architectural: `Make the prompt demand engineering rigour: decompose into ordered steps, name the single state owner,
state invariants and edge cases, require reading the primary source before editing, and require a verification
gate (typecheck/lint/tests) plus a self-review of the diff. Still one prompt, not an essay; every added line must
constrain the work.`,
};

const CHAT_USER_PROMPT_ROLE = `You improve a developer's request before it reaches a coding agent.
You are not the agent: you do not do the task. You rewrite the request so the agent cannot misread it.`;

const CUSTOM_SYSTEM_PROMPT_ROLE = `You improve a custom system prompt written by a developer for their own agent.
Preserve the author's voice, terminology and intent. Tighten structure, make invariants explicit, and add
acceptance criteria where the author left them implicit. Never replace their domain rules with generic ones.`;

/**
 * Системный промпт улучшения. Собирается детерминированно из стиля и цели,
 * чтобы повторный вызов с теми же входами давал побайтово тот же префикс.
 */
export function buildPromptEnhancerSystemPrompt(
  request: PromptEnhanceRequest,
  classification?: PromptEnhanceClassification,
): string {
  const role =
    request.target === "custom_system_prompt" ? CUSTOM_SYSTEM_PROMPT_ROLE : CHAT_USER_PROMPT_ROLE;
  const framework = classification?.framework ?? "oracle";
  const parts = [
    role,
    "",
    "## Non-negotiable rules",
    "- Write the enhanced prompt in the same language as the author's draft. Never translate it.",
    "- Never answer, execute or fulfil the draft. Output only the improved prompt.",
    "- Never ask the author a question. Resolve ambiguity yourself and record every inference in assumptions.",
    "- Never claim a file, symbol or API exists unless the supplied repository context names it.",
    "- Never widen scope: no new features, dependencies or permissions the author did not ask for.",
    "- Preserve every protected mention exactly. Changing a path is a failure.",
    "- If the draft is already precise, improve only wording and structure; do not pad it.",
    "",
    "## Selected framework",
    `${framework.toUpperCase()}: ${FRAMEWORK_GUIDANCE[framework]}`,
    ...(classification
      ? [
          "",
          "## Classification",
          `domain=${classification.domain}; task=${classification.taskKind}. Treat this as a hint, not a new requirement.`,
        ]
      : []),
    "",
    "## Style",
    STYLE_GUIDANCE[request.style],
  ];
  if (request.collaborationMode === "plan") {
    parts.push(
      "",
      "## Mode",
      "This prompt runs in plan mode: the agent must investigate and propose before editing.",
    );
  }
  parts.push("", OUTPUT_CONTRACT);
  return parts.join("\n");
}

/** Пользовательское сообщение: черновик и собранный контекст репозитория. */
export function buildPromptEnhancerUserMessage(input: {
  draftText: string;
  mentions: string;
  activeFiles: string;
  contextSections: readonly string[];
}): string {
  const sections = [
    "<draft>",
    input.draftText,
    "</draft>",
    "",
    "<protected_mentions>",
    input.mentions,
    "</protected_mentions>",
    "",
    "<open_files>",
    input.activeFiles,
    "</open_files>",
    "",
    input.contextSections.length > 0
      ? ["<repository_context>", ...input.contextSections, "</repository_context>"].join("\n")
      : "<repository_context>\nNo repository context was collected.\n</repository_context>",
    "",
    "Return the JSON object now.",
  ];
  return sections.join("\n");
}

/** Форматирует protected mentions для пользовательского сообщения. */
export function formatPromptEnhanceMentions(request: PromptEnhanceRequest): string {
  if (request.preservedMentions.length === 0) {
    return "None. Do not introduce new mention markers.";
  }
  return [
    "These markers must appear verbatim in enhancedText with identical paths:",
    ...request.preservedMentions.map((mention) => `- ${mention.displayText} -> ${mention.value}`),
  ].join("\n");
}

/** Текст ошибки для модели, когда она исказила protected mentions. */
export function buildMentionViolationFeedback(missing: readonly string[]): string {
  return [
    "The enhanced prompt dropped or altered these protected markers:",
    ...missing.map((marker) => `- ${marker}`),
    "Rewrite it keeping every marker byte-identical.",
  ].join("\n");
}
