import {
  validateModelSelectionOptions,
  type ModelSelection,
  type ProviderRegistryView,
} from "./registry.js";

export type InitialModelSelectionResolution =
  | {
      readonly source: "configured-default" | "registry-fallback";
      readonly selection: ModelSelection;
    }
  | { readonly source: "none" };

interface ModelSelectionCompletionView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
        };
      };
    }[];
  }[];
}

export function resolveInitialModelSelection(input: {
  readonly configuredDefault?: ModelSelection;
  readonly registry: ProviderRegistryView;
}): InitialModelSelectionResolution {
  // 这里只构造 Host 的初始推荐，不解析已有会话意图。失效默认是可丢弃偏好，
  // 应继续按 Registry 顺序推荐；不能把历史选择留空的规则误用于新草稿初始化。
  if (input.configuredDefault) {
    const migrated = migrateLegacyCursorSelection(input.registry, input.configuredDefault);
    const configured = migrated ?? input.configuredDefault;
    if (isSelectable(input.registry, configured)) {
      return {
        source: "configured-default",
        selection: freezeSelection(configured),
      };
    }
  }

  // 仅用于全新草稿的 Host 初始推荐；历史未绑定状态不能进入这个初始化分支。
  for (const provider of input.registry.providers) {
    if (provider.config.visibility === "hidden") continue;
    for (const model of provider.models) {
      const selection = completeNewModelSelection(input.registry, {
        providerId: provider.providerId,
        modelId: model.modelId,
      });
      if (selection) return { source: "registry-fallback", selection: freezeSelection(selection) };
    }
  }
  return { source: "none" };
}

/** 仅在用户主动选模型或全新初始化时构造最高档；不能用于恢复/重解析已有选择。 */
export function completeNewModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const model = registry.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel },
  };
}

/**
 * 规范化一份待提交的 Selection。
 * 已有选择缺失或失效时只保留模型身份，等待用户选择档位；主动选模型另走 completion。
 * 任何执行入口都必须在此之后再次确认 Selection 完整，不能静默补档位。
 */
export function normalizeModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  const effective = migrateLegacyModelSelection(registry, selection);
  const model = registry.providers
    .find((provider) => provider.providerId === effective.providerId)
    ?.models.find((candidate) => candidate.modelId === effective.modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = effective.options?.reasoningLevel;
  if (reasoningLevel !== undefined && values.includes(reasoningLevel)) return effective;
  return {
    providerId: effective.providerId,
    modelId: effective.modelId,
  };
}

/** Applies only lossless legacy-id migrations; never clears a user's explicit option. */
export function migrateLegacyModelSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection {
  return migrateLegacyCursorSelection(registry, selection) ?? selection;
}

/**
 * Cursor used to expose one flat model id per reasoning/speed combination. After the
 * catalog is grouped, a persisted selection such as `grok-4.7-xhigh-fast` must become
 * `grok-4.7-fast` + `reasoningLevel: xhigh`, otherwise the next session silently
 * falls back to `auto` and shows the model-changed notice.
 */
function migrateLegacyCursorSelection(
  registry: ModelSelectionCompletionView,
  selection: ModelSelection,
): ModelSelection | undefined {
  if (selection.providerId !== "cursor") return undefined;
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (!provider) return undefined;
  // 关键：同名 selector 已存在时不能再解析尾缀。grouped id `grok-4.7-fast` 与
  // `claude-...-no-thinking` 也会被 parseCursorModelId 解析出 fast/no-thinking，
  // 旧实现会拿它们再迁移一次，把用户显式选择的 reasoningLevel 覆盖成最后一档。
  if (provider.models.some((candidate) => candidate.modelId === selection.modelId)) {
    return undefined;
  }
  const parsed = parseCursorModelId(selection.modelId);
  const modelId = `${parsed.baseId}${parsed.fast ? "-fast" : ""}`;
  const model = provider.models.find((candidate) => candidate.modelId === modelId);
  if (!model) return undefined;
  const values = model.config.optionSpecs.reasoningLevel.values;
  const explicit = selection.options?.reasoningLevel;
  // 旧 flat id 中的档位是权威事实；没有可识别档位时保留用户显式选项，最后才用默认档。
  const reasoningLevel =
    (values.includes(parsed.level) ? parsed.level : undefined) ??
    (explicit && values.includes(explicit) ? explicit : undefined) ??
    values[0];
  if (!reasoningLevel) return undefined;
  return {
    providerId: selection.providerId,
    modelId,
    options: { reasoningLevel },
  };
}

function isSelectable(registry: ProviderRegistryView, selection: ModelSelection): boolean {
  const provider = registry.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (provider?.config.visibility === "hidden") return false;
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return validateModelSelectionOptions(model, selection).ok;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}

/**
 * Cursor CLI reports a flat catalog where every reasoning/speed combination is a
 * separate model id (`gpt-5.3-codex-low`, `...-low-fast`, `...-high`, ...). The
 * provider must expose one selectable model plus a reasoning-level selector, not
 * 285 near-duplicate entries. This module owns that pure projection.
 */

const LEVEL_ORDER = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const LEVEL_TOKENS = new Set<string>(LEVEL_ORDER.filter((level) => level !== "default"));
const LEVEL_WORD_PATTERN = /\b(?:extra[\s-]+high|xhigh|high|medium|low|minimal|none|default)\b/iu;
const FAST_WORD_PATTERN = /\bfast\b/iu;
const NO_THINKING_SUFFIX = "no-thinking";

export interface CursorReasoningLevel {
  readonly level: string;
  readonly modelId: string;
}

export interface CursorGroupedModel {
  /** Selector id: base id plus `-fast` for the speed variant. */
  readonly modelId: string;
  readonly name: string;
  readonly source: "cli" | "baseline";
  readonly reasoningLevels: readonly CursorReasoningLevel[];
}

export function parseCursorModelId(modelId: string): {
  baseId: string;
  level: string;
  fast: boolean;
  noThinking: boolean;
} {
  const tokens = modelId.split("-").filter(Boolean);
  let fast = false;
  if (tokens.at(-1) === "fast") {
    fast = true;
    tokens.pop();
  }
  let noThinking = false;
  if (tokens.at(-1) === "thinking" && tokens.at(-2) === "no") {
    noThinking = true;
    tokens.pop();
    tokens.pop();
  }
  let level = "default";
  const last = tokens.at(-1);
  if (last && LEVEL_TOKENS.has(last)) {
    level = last;
    tokens.pop();
  }
  return {
    baseId: tokens.join("-") + (noThinking ? `-${NO_THINKING_SUFFIX}` : ""),
    level,
    fast,
    noThinking,
  };
}

function baseName(name: string, modelId: string, fast: boolean): string {
  const stripped = name
    .replace(LEVEL_WORD_PATTERN, " ")
    .replace(FAST_WORD_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .replace(/[-:–—,]+$/u, "")
    .trim();
  const resolved = stripped.length > 0 ? stripped : modelId;
  // The fast variant is a distinct selector; keep the distinction visible when the
  // CLI's display name does not already include it.
  return fast && !/\bfast\b/iu.test(resolved) ? `${resolved} Fast` : resolved;
}

function sortLevels(left: CursorReasoningLevel, right: CursorReasoningLevel): number {
  const leftIndex = LEVEL_ORDER.indexOf(left.level as (typeof LEVEL_ORDER)[number]);
  const rightIndex = LEVEL_ORDER.indexOf(right.level as (typeof LEVEL_ORDER)[number]);
  return (
    (leftIndex < 0 ? LEVEL_ORDER.length : leftIndex) -
    (rightIndex < 0 ? LEVEL_ORDER.length : rightIndex)
  );
}

export interface CursorCatalogModel {
  readonly modelId: string;
  readonly name: string;
  readonly source: "cli" | "baseline";
}

export function groupCursorModels(models: readonly CursorCatalogModel[]): CursorGroupedModel[] {
  const groups = new Map<
    string,
    {
      baseId: string;
      fast: boolean;
      name: string;
      source: "cli" | "baseline";
      levels: CursorReasoningLevel[];
    }
  >();

  for (const model of models) {
    const parsed = parseCursorModelId(model.modelId);
    const key = `${parsed.baseId}::${parsed.fast ? "fast" : "normal"}`;
    const group = groups.get(key) ?? {
      baseId: parsed.baseId,
      fast: parsed.fast,
      name: baseName(model.name, parsed.baseId, parsed.fast),
      source: model.source,
      levels: [],
    };
    if (group.source !== "cli" && model.source === "cli") group.source = "cli";
    if (model.name.trim().length > 0 && group.levels.length === 0) {
      group.name = baseName(model.name, parsed.baseId, parsed.fast);
    }
    group.levels.push({ level: parsed.level, modelId: model.modelId });
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const levels = [...group.levels].sort(sortLevels);
    // A base with only the bare/default id has no meaningful reasoning choice.
    const reasoningLevels =
      levels.length === 1 && levels[0]?.level === "default"
        ? [{ level: "disabled", modelId: levels[0].modelId }]
        : levels;
    return {
      modelId: `${group.baseId}${group.fast ? "-fast" : ""}`,
      name: group.name,
      source: group.source,
      reasoningLevels,
    } satisfies CursorGroupedModel;
  });
}

function escapeCelString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/**
 * Restricted-CEL option map understood by `compileModelOptionMaps`. Cursor's
 * provider reads `modelId` from the evaluated patch before spawning the CLI.
 */
export function buildCursorReasoningMap(levels: readonly CursorReasoningLevel[]): string {
  if (levels.length === 0) throw new Error("cursor reasoning levels must not be empty");
  const fallback = levels.at(-1)!;
  let expression = `{'modelId': '${escapeCelString(fallback.modelId)}'}`;
  for (let index = levels.length - 2; index >= 0; index -= 1) {
    const level = levels[index]!;
    expression = `reasoningLevel == '${escapeCelString(level.level)}' ? {'modelId': '${escapeCelString(
      level.modelId,
    )}'} : ${expression}`;
  }
  return expression;
}
