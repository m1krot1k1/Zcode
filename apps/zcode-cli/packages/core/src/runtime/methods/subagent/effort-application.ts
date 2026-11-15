import { CoreErrorType, createCoreError } from "../../deps.js";
import type { Logger, Model, ModelSelection } from "../../deps.js";
import type { AgentRuntimeDeps } from "../../types.js";
import { resolveSubagentEffortLevel } from "../../helpers/subagent-effort.js";

type ModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

interface EffortCatalogEntry {
  providerId: string;
  modelId: string;
  disabledReason?: string;
  reasoningLevels?: readonly string[];
  defaultReasoningLevel?: string;
}

export interface ApplySubagentEffortInput {
  effort?: string;
  effortAboveParent?: boolean;
  agentType: string;
  childSelection: ModelSelection;
  parentSelection: ModelSelection | undefined;
  parentModel?: Model;
  childModel: Model;
  baseFactory: ModelFactory;
  rebuildFactory: (selection: ModelSelection) => ModelFactory | undefined;
  catalogEntries?: readonly EffortCatalogEntry[];
  logger?: Logger;
}

export interface ApplySubagentEffortResult {
  childSelection: ModelSelection;
  childModel: Model;
  baseFactory: ModelFactory;
}

/**
 * Applies the relative effort class after the existing override→profile→parent
 * selection resolution. Model identity never changes; only the level in the
 * target model's own scale.
 */
export function applySubagentEffortSelection(
  input: ApplySubagentEffortInput,
): ApplySubagentEffortResult {
  if (input.effort === undefined) {
    return {
      childSelection: input.childSelection,
      childModel: input.childModel,
      baseFactory: input.baseFactory,
    };
  }
  const findCatalogEntry = (selection: ModelSelection): EffortCatalogEntry | undefined =>
    input.catalogEntries?.find(
      (entry) =>
        entry.providerId === selection.providerId &&
        entry.modelId === selection.modelId &&
        entry.disabledReason === undefined,
    );
  const parentCatalogEntry = input.parentSelection
    ? findCatalogEntry(input.parentSelection)
    : undefined;
  const parentLevel =
    input.parentModel?.options.reasoningLevel ??
    input.parentSelection?.options?.reasoningLevel ??
    parentCatalogEntry?.defaultReasoningLevel;
  const childCatalogEntry = findCatalogEntry(input.childSelection);
  const supportedLevels =
    childCatalogEntry?.reasoningLevels ?? input.childModel.optionSpecs.reasoningLevel.values;
  const effortResolution = resolveSubagentEffortLevel({
    effort: input.effort,
    effortAboveParent: input.effortAboveParent,
    baseLevel: input.childSelection.options?.reasoningLevel,
    parentLevel,
    supportedLevels,
  });
  if (effortResolution.outcome === "unknown-class") {
    input.logger?.warn("Subagent effort class is unknown; keeping the resolved level", {
      event: "subagent.effort.unknown_class",
      module: "core.subagent",
      agentType: input.agentType,
      effort: input.effort,
    });
  } else {
    input.logger?.debug("Subagent effort resolved", {
      event: "subagent.effort.resolved",
      module: "core.subagent",
      agentType: input.agentType,
      effort: input.effort,
      outcome: effortResolution.outcome,
      reasoningLevel: effortResolution.level,
      baseClamped: effortResolution.baseClamped,
    });
  }
  if (
    !effortResolution.level ||
    effortResolution.level === input.childSelection.options?.reasoningLevel
  ) {
    return {
      childSelection: input.childSelection,
      childModel: input.childModel,
      baseFactory: input.baseFactory,
    };
  }
  const childSelection: ModelSelection = {
    ...input.childSelection,
    options: { ...input.childSelection.options, reasoningLevel: effortResolution.level },
  };
  const baseFactory = input.rebuildFactory(childSelection);
  if (!baseFactory) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
      { recoverable: true },
    );
  }
  return {
    childSelection,
    childModel: baseFactory({ selection: childSelection }),
    baseFactory,
  };
}
