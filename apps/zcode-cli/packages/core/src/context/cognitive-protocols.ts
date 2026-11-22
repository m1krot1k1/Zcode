// ============================================================
// Cognitive Protocols & Prompt Depth Profiles (Increment 4.4)
// ============================================================

/**
 * Профили глубины рассуждений.
 *
 * Сам enum живёт в `@zcode/shared` (`promptDepth`): его читают схема настроек и рантайм,
 * поэтому второй копии здесь быть не должно. Этот модуль добавляет к профилю то, что
 * видит только промпт: текст пяти когнитивных протоколов и бюджет рассуждения.
 *
 * Профиль фиксируется на сессию, поэтому блок протоколов остаётся в кэшируемом префиксе
 * и не инвалидируется при смене напоминаний, todo или режима.
 */
import {
  DEFAULT_PROMPT_DEPTH_PROFILE,
  PROMPT_DEPTH_PROFILES,
  isPromptDepthProfile,
  resolvePromptDepthProfile,
  type PromptDepthProfile,
} from "@zcode/shared";

export {
  DEFAULT_PROMPT_DEPTH_PROFILE,
  PROMPT_DEPTH_PROFILES,
  isPromptDepthProfile,
  resolvePromptDepthProfile,
};
export type { PromptDepthProfile };

/** Стабильные id протоколов: используются тестами и настройками, не переименовывать. */
export const COGNITIVE_PROTOCOL_IDS = [
  "plan_before_mutation",
  "invariants_and_edges",
  "evidence_grounded",
  "self_critique_gate",
  "zero_stub_surgical_edit",
] as const;
export type CognitiveProtocolId = (typeof COGNITIVE_PROTOCOL_IDS)[number];

/** Заголовки секций: стабильная точка навигации для человека и для проверок. */
export const COGNITIVE_PROTOCOL_HEADINGS: Record<CognitiveProtocolId, string> = {
  plan_before_mutation: "Protocol 1 — Plan and Architecture Before Mutation",
  invariants_and_edges: "Protocol 2 — Invariants, Data Contracts, Edge Cases",
  evidence_grounded: "Protocol 3 — Evidence-Grounded Verification",
  self_critique_gate: "Protocol 4 — Self-Critique and Gate Check",
  zero_stub_surgical_edit: "Protocol 5 — Zero-Stub and Surgical Edit Mandate",
};

interface ProtocolText extends Record<PromptDepthProfile, string> {
  id: CognitiveProtocolId;
}

const PROTOCOLS: readonly ProtocolText[] = [
  {
    id: "plan_before_mutation",
    standard: [
      "Before the first mutating call (Write, Edit, MultiEdit, ApplyPatch, or a Bash command that changes state), state the plan in one short block: files touched, the order, and how you will know it worked.",
      "Investigate first: read the files and schemas the change depends on. Skip the plan only for a single-file fix whose cause you already read.",
    ].join("\n"),
    deep: [
      "Before the first mutating call (Write, Edit, MultiEdit, ApplyPatch, or a state-changing Bash command), commit to an explicit plan: goal, current behavior and its cause, files and symbols to change, the state owner after the change, and the verification commands you will run.",
      "Name the rejected alternative and why you rejected it. If the plan needs more than three ordered steps, write it down and update it as evidence changes.",
    ].join("\n"),
    max_reasoning: [
      "Before the first mutating call (Write, Edit, MultiEdit, ApplyPatch, or a state-changing Bash command), produce a structured design record: goal and acceptance criteria, current behavior with the evidence that proves it, the exact files/symbols to change, the single state owner after the change, event order and idempotency boundaries, the rejected alternatives with reasons, and the verification gate.",
      "Do not start editing while the design record still has an unverified assumption that decides the shape of the change. Prefer the smallest coherent change that satisfies the criteria over a broad refactor.",
    ].join("\n"),
  },
  {
    id: "invariants_and_edges",
    standard: [
      "Name the invariants your change must preserve and the edge cases it must handle (empty, missing, concurrent, remote, permission-denied) before editing. If an invariant is unclear, read the owner of that state instead of guessing.",
    ].join("\n"),
    deep: [
      "State the invariants explicitly: what must always hold, who owns each piece of state, which write path is authoritative, and what the contract at the public entrypoint promises.",
      "Enumerate the edge cases you must handle (empty, missing, malformed, concurrent, remote/offline, permission-denied, cancellation) and say which ones your change touches. Anything you leave unhandled must be named as a residual risk.",
    ].join("\n"),
    max_reasoning: [
      "State the invariants as testable sentences: what must always hold, the unique owner of each piece of state, the authoritative write path, the ordering and idempotency guarantees, and the contract at every public entrypoint you touch.",
      "Enumerate the edge matrix (empty, missing, malformed, duplicated, concurrent, remote/offline, permission-denied, cancellation, timeout) and mark each cell handled, out of scope, or residual risk. Duplicated state or a second write path is a design defect: fix the owner, do not add a fallback branch.",
    ].join("\n"),
  },
  {
    id: "evidence_grounded",
    standard: [
      "Verify load-bearing claims against primary sources: read the real file, schema, type, test, or log. Summaries, memory, TODO notes, and agent reports are leads, not proof.",
      "Never state that a command, test, endpoint, or field behaves in a certain way without having read or run it in this task.",
    ].join("\n"),
    deep: [
      "Verify every load-bearing claim against primary sources: the actual file content, schema, type definition, test, migration, or runtime log. Read the definition and the caller, not just the name.",
      "Treat summaries, generated reports, memory, and child-agent output as leads that require a first-hand check. If two sources disagree, quote both and resolve it by reading the authoritative one.",
    ].join("\n"),
    max_reasoning: [
      "Verify every load-bearing claim against primary sources: the actual file content at the current commit, schema, type definition, test, migration, and runtime log. Read the definition, the callers, and the tests that pin the behavior.",
      "Treat summaries, generated reports, memory, docs, and child-agent output as unverified leads. When sources disagree, record both, then resolve by reading the authoritative one. Distinguish confirmed causes from hypotheses in everything you report.",
    ].join("\n"),
  },
  {
    id: "self_critique_gate",
    standard: [
      "After editing, run the verification that matches the layer you changed (targeted test, typecheck, lint, build). Then read your own diff and fix what it reveals.",
      "Report real results: passing, failing, or not run. Never describe a plan as an executed check.",
    ].join("\n"),
    deep: [
      "After editing, run the verification that matches the layer you changed (targeted test, typecheck, lint, build, real UI run) and read the full output, not just the exit code.",
      "Review your own diff as a skeptical reviewer: dead code, debug leftovers, unintended formatting, weakened assertions, missing error handling, scope creep. Fix what you find before reporting, and state explicitly what you did not verify.",
    ].join("\n"),
    max_reasoning: [
      "After editing, run the full gate for the affected scope (targeted tests, typecheck, lint, build, and a real UI or CLI run when the change is interactive) and read the complete output.",
      "Then audit your own diff adversarially: every added branch must be reachable, every invariant from Protocol 2 must still hold, no assertion was weakened, no debug artifact remains, and no unrelated file changed. Re-run the gate after any fix. Report what passed, what failed, and what was not run, with the same precision you would demand from a reviewer.",
    ].join("\n"),
  },
  {
    id: "zero_stub_surgical_edit",
    standard: [
      "No stubs, TODOs, placeholders, hardcoded returns, or `any` casts to get past the compiler. No truncating a function and leaving the rest unstated.",
      "Change only what the task needs. Keep unrelated local edits untouched.",
    ].join("\n"),
    deep: [
      "Deliver complete behavior, not a first slice: no stubs, TODOs, placeholder branches, hardcoded values, swallowed errors, or `any` casts to silence types. If a symbol needs a body, write the body.",
      "Produce surgical diffs: only the lines the task needs, no drive-by renames or reformatting. If a tool call is truncated (`TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`), re-emit the complete call after the self-repair prompt instead of shrinking the change.",
    ].join("\n"),
    max_reasoning: [
      "Deliver complete behavior in one pass: no stubs, TODOs, placeholder branches, hardcoded values, swallowed errors, `any`/`unknown` escapes, or commented-out code. A partial implementation reported as finished is a failure.",
      "Produce surgical diffs only: the lines the task needs, no drive-by renames or reformatting, one writer per file. When the runtime reports `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`, follow the self-repair prompt and re-emit the complete call; never shrink the change to fit the budget. If the scope is genuinely too large, split it into named steps and complete each one.",
    ].join("\n"),
  },
];

export interface PromptDepthRuntimeTuning {
  profile: PromptDepthProfile;
  /** Уровень, который понимает `resolveThinkingBudgetTokens`. */
  reasoningEffort: "medium" | "high" | "max";
  /** Явный бюджет рассуждения в токенах; согласован с `resolveThinkingBudgetTokens`. */
  thinkingBudgetTokens: number;
  /** Минимальный выходной бюджет; рантайм может увеличить его под резерв инструментов. */
  minMaxOutputTokens: number;
}

/**
 * Параметры запроса для профиля глубины.
 *
 * Значения подобраны так, чтобы `resolveReasoningAwareMaxOutputTokens` не срезал
 * резерв под JSON-аргументы инструментов (16 384 из инкремента 4.1):
 * `deep` и `max_reasoning` запрашивают thinking + резерв, а не только thinking.
 */
export const PROMPT_DEPTH_RUNTIME_TUNING: Record<PromptDepthProfile, PromptDepthRuntimeTuning> = {
  standard: {
    profile: "standard",
    reasoningEffort: "medium",
    thinkingBudgetTokens: 8_192,
    minMaxOutputTokens: 32_768,
  },
  deep: {
    profile: "deep",
    reasoningEffort: "high",
    thinkingBudgetTokens: 16_384,
    minMaxOutputTokens: 40_960,
  },
  max_reasoning: {
    profile: "max_reasoning",
    reasoningEffort: "max",
    thinkingBudgetTokens: 31_999,
    minMaxOutputTokens: 49_152,
  },
};

/** Нормализует внешнее значение и подбирает бюджет рассуждения для профиля. */
export function resolvePromptDepthRuntimeTuning(value: unknown): PromptDepthRuntimeTuning {
  return PROMPT_DEPTH_RUNTIME_TUNING[resolvePromptDepthProfile(value)];
}

/**
 * Текст блока когнитивных протоколов.
 *
 * Функция чистая и детерминированная: один и тот же профиль даёт побайтово тот же
 * текст. Это обязательное условие для кэшируемого префикса (инкремент 4.4, п.4).
 */
export function buildCognitiveProtocolsBlock(profile: PromptDepthProfile): string {
  const lines = [
    "# Cognitive protocols",
    "",
    "These five protocols are mandatory for every non-trivial task. They gate mutation, not conversation: a direct question still gets a direct answer.",
    "",
  ];
  for (const protocol of PROTOCOLS) {
    lines.push(`## ${COGNITIVE_PROTOCOL_HEADINGS[protocol.id]}`, protocol[profile], "");
  }
  return lines.join("\n").trimEnd();
}

/** Только идентификаторы, реально присутствующие в блоке: для проверок покрытия. */
export function listCognitiveProtocolIds(block: string): CognitiveProtocolId[] {
  return COGNITIVE_PROTOCOL_IDS.filter((id) => block.includes(COGNITIVE_PROTOCOL_HEADINGS[id]));
}
