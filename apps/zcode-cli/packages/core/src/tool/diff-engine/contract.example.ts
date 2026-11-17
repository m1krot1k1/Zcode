/**
 * cli-diff-engine стандартный пример использования публичного контракта.
 */
import type { IMultiTierDiffEngine } from "./contract.js";

export function exampleCliDiffEngine(engine: IMultiTierDiffEngine): string {
  const outcome = engine.applyEdit("def run():\r\n    value = 1\r\n    return value\r\n", {
    oldString: "  value = 1\n  return value",
    newString: "  value = 2\n  if value > 0:\n    return value",
  });
  return outcome.status === "matched" ? outcome.content : outcome.diagnostic.formatted;
}
