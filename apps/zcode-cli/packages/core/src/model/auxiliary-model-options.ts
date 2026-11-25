import type { Model, ModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * 辅助调用统一使用公开档位的最低项，并限制输出预算；档位顺序来自 Model Config，
 * 不能再按 disabled/off 等名字推断协议行为。
 *
 * Some providers and test models expose no reasoning scale at all. Binding an undefined
 * `reasoningLevel` used to crash compact/title/WebSearch sidecars with
 * "Cannot read properties of undefined (reading 'values')"; omit the option instead and let
 * the model keep its own default.
 */
export function auxiliaryModelOptions(model: Model): ModelOptions {
  const reasoningLevel = model.optionSpecs.reasoningLevel?.values[0];
  const maxOutputTokens = model.optionSpecs.maxOutputTokens?.max;
  return {
    ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
    ...(typeof maxOutputTokens === "number"
      ? { maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, maxOutputTokens) }
      : {}),
  };
}
