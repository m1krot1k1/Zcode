/**
 * Детерминированный выбор reasoning level для корневого turn.
 *
 * Классификатор не вызывает модель и не меняет пользовательскую настройку:
 * он лишь понижает/повышает уровень в пределах supportedLevels активной модели.
 * Явный выбор пользователя (композер или /effort) всегда главнее и сюда не попадает.
 */

export type RootAutoEffortTier = "simple" | "normal" | "complex";

export interface RootAutoEffortInput {
  prompt: string;
  planEnabled?: boolean;
  /** Признак task_graph-подобной декомпозиции в запросе. */
  hasTaskGraph?: boolean;
  /** Уровни целевой модели от низкого к высокому. */
  supportedLevels: readonly string[];
}

export interface RootAutoEffortResult {
  level: string;
  tier: RootAutoEffortTier;
  score: number;
}

const DISABLED_LEVEL = /^(?:disabled|off|none|no|false|nothink|no[-_]?think)$/iu;

const IMPLEMENTATION_WORDS =
  /(?:implement|refactor|migrate|rewrite|build|fix|debug|architecture|design|implement|реализ|отрефактор|перепиш|почини|исправ|спроект|архитектур|миграц)/iu;
const COMPLEX_WORDS =
  /(?:multi[- ]?step|end[- ]?to[- ]?end|diagnos|investigat|reproduce|benchmark|optimi[sz]|concurren|race|security|performance|многошаг|сквозн|диагност|исследуй|воспроизвед|оптимиз|производительн|конкурент|безопасн)/iu;
const LIST_OR_HEADING = /(?:^|\n)\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/u;
const CODE_FENCE = /```/u;
const PATH_LIKE = /(?:^|[\s`"'(])(?:[\w@.+-]+\/){2,}[\w@.+-]+/gu;

function countPathLikeMentions(prompt: string): number {
  let count = 0;
  for (const _match of prompt.matchAll(PATH_LIKE)) count += 1;
  return count;
}

/** Оценка сложности по структуре и явным маркерам, без вызова модели. */
export function scoreRootPrompt(input: Pick<RootAutoEffortInput, "prompt" | "planEnabled" | "hasTaskGraph">): number {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) return 0;
  let score = 0;
  if (prompt.length > 160) score += 1;
  if (prompt.length > 600) score += 1;
  if (prompt.length > 1_800) score += 1;
  if (CODE_FENCE.test(prompt)) score += 1;
  if (LIST_OR_HEADING.test(prompt)) score += 1;
  if (IMPLEMENTATION_WORDS.test(prompt)) score += 1;
  if (COMPLEX_WORDS.test(prompt)) score += 1;
  if (countPathLikeMentions(prompt) >= 3) score += 1;
  if (input.planEnabled === true) score += 1;
  if (input.hasTaskGraph === true) score += 2;
  return score;
}

function enabledLevels(supportedLevels: readonly string[]): string[] {
  return supportedLevels.map((level) => level.trim()).filter((level) => level.length > 0 && !DISABLED_LEVEL.test(level));
}

/**
 * Пустой массив, только disabled-уровни или пустой prompt → undefined: runtime
 * оставляет уровень как есть, без ошибки и без ретрая.
 */
export function resolveRootAutoEffort(input: RootAutoEffortInput): RootAutoEffortResult | undefined {
  if (input.prompt.trim().length === 0) return undefined;
  const levels = enabledLevels(input.supportedLevels);
  if (levels.length === 0) return undefined;
  const score = scoreRootPrompt(input);
  const tier: RootAutoEffortTier = score === 0 ? "simple" : score <= 1 ? "normal" : "complex";
  let index = levels.length - 1;
  if (tier === "simple") {
    index = 0;
  } else if (tier === "normal" && levels.length >= 3) {
    index = levels.length - 2;
  }
  return { level: levels[index]!, tier, score };
}
