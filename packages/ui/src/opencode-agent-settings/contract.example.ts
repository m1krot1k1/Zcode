import {
  findOpenCodeConfigOption,
  getOpenCodeSelectValues,
  type OpenCodeAgentConfigOption,
} from "./contract.js";

/** Settings renders only values returned by the current ACP session. */
export function exampleOpenCodeModelSelection(configOptions: OpenCodeAgentConfigOption[]) {
  const model = findOpenCodeConfigOption(configOptions, "model");
  return model
    ? { currentValue: model.currentValue, options: getOpenCodeSelectValues(model) }
    : null;
}
