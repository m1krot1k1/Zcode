/**
 * Относительный класс reasoning effort для одного спавна сабагента.
 *
 * Модель не должна выбирать абсолютный `reasoningLevel`: названия и шкала уровней
 * принадлежат целевой модели, а исторические tool calls не должны пинить настройку
 * пользователя. Поэтому `Task`/`Agent` принимает только относительный класс, а
 * конкретный уровень резолвится здесь в момент спавна по актуальной шкале модели.
 */

export type SubagentEffortClass = "lowest" | "lower" | "same" | "higher";

export type SubagentEffortOutcome =
  | "applied"
  | "clamped"
  | "elevation-denied"
  | "no-supported-levels"
  | "no-anchor"
  | "unknown-class";

export interface ResolveSubagentEffortLevelInput {
  /** Как пришло из tool input/истории; сужение до класса делает resolver. */
  effort?: string;
  /** highest — служебная политика роли (оркестратор), не выбор модели. */
  policy?: "relative" | "highest";
  /** Явное разрешение поднять ребёнка выше родителя. */
  effortAboveParent?: boolean;
  /** Уровень из уже разрешённой child selection (profile/override/parent). */
  baseLevel?: string;
  /** Эффективный уровень родителя в этом turn. */
  parentLevel?: string;
  /** Поддерживаемые целевой моделью уровни, от низкого к высокому. */
  supportedLevels: readonly string[];
}

export interface ResolveSubagentEffortLevelResult {
  level?: string;
  outcome: SubagentEffortOutcome;
  /** Base level не найден в шкале и заменён ближайшей поддерживаемой опорой. */
  baseClamped?: true;
}

const EFFORT_DELTA: Readonly<Record<Exclude<SubagentEffortClass, "lowest">, number>> = {
  lower: -1,
  same: 0,
  higher: 1,
};

const DISABLED_LEVEL = /^(?:disabled|off|none|no|false|nothink|no[-_]?think)$/iu;

function isSubagentEffortClass(value: string): value is SubagentEffortClass {
  return value === "lowest" || value === "lower" || value === "same" || value === "higher";
}

/**
 * Чистый резолвер без I/O. Порядок шагов зафиксирован спецификацией
 * `docs/specs/2026-11-14-subagent-reasoning-effort-level.md`.
 */
export function resolveSubagentEffortLevel(
  input: ResolveSubagentEffortLevelInput,
): ResolveSubagentEffortLevelResult {
  const supportedLevels = input.supportedLevels;
  const baseLevel = input.baseLevel?.trim();
  const parentLevel = input.parentLevel?.trim();

  if (supportedLevels.length === 0) {
    return { outcome: "no-supported-levels" };
  }

  if (input.policy === "highest") {
    // Оркестратор — единственная роль с политикой highest: модель остаётся
    // выбранной пользователем, меняется только reasoning level в её шкале.
    return { level: supportedLevels[supportedLevels.length - 1]!, outcome: "applied" };
  }

  const effort = input.effort?.trim().toLowerCase();
  if (!effort || !isSubagentEffortClass(effort)) {
    return {
      outcome: "unknown-class",
      ...(baseLevel ? { level: baseLevel } : {}),
    };
  }

  if (effort === "lowest") {
    // lowest нужен для разреженных шкал (disabled/low/high/max): lower с max
    // попадает только в high, а механическая ветка должна дойти до low.
    // disabled/off не являются рабочим уровнем и не выбираются.
    const lowestWorkingLevel = supportedLevels.find(
      (level) => level.trim().length > 0 && !DISABLED_LEVEL.test(level.trim()),
    );
    return lowestWorkingLevel
      ? { level: lowestWorkingLevel, outcome: "applied" }
      : { outcome: "no-supported-levels" };
  }

  const baseIndex = baseLevel ? supportedLevels.indexOf(baseLevel) : -1;
  const parentIndex = parentLevel ? supportedLevels.indexOf(parentLevel) : -1;

  if (!baseLevel && !parentLevel) {
    return { outcome: "no-anchor" };
  }

  let anchorIndex: number;
  let baseClamped = false;
  if (baseIndex >= 0) {
    anchorIndex = baseIndex;
  } else if (parentIndex >= 0) {
    anchorIndex = parentIndex;
    baseClamped = true;
  } else {
    anchorIndex = 0;
    baseClamped = true;
  }

  const delta = EFFORT_DELTA[effort];
  let targetIndex = Math.min(
    Math.max(anchorIndex + delta, 0),
    supportedLevels.length - 1,
  );
  let outcome: SubagentEffortOutcome = "applied";

  if (input.effortAboveParent !== true && delta > 0) {
    if (parentIndex >= 0 && targetIndex > parentIndex) {
      targetIndex = parentIndex;
      outcome = "clamped";
    } else if (parentIndex < 0) {
      targetIndex = anchorIndex;
      outcome = "elevation-denied";
    }
  } else if (input.effortAboveParent !== true && delta <= 0) {
    // Инвариант «не выше родителя» действует и для lower/same: профиль мог быть
    // настроен выше родителя, но переданный класс подчиняет итог родителю.
    if (parentIndex >= 0 && targetIndex > parentIndex) {
      targetIndex = parentIndex;
      outcome = "clamped";
    }
  }

  return {
    level: supportedLevels[targetIndex],
    outcome,
    ...(baseClamped ? { baseClamped: true as const } : {}),
  };
}
