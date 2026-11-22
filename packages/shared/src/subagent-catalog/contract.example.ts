/**
 * shared-subagent-catalog 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SharedSubagentCatalogContract } from "./contract.js";

export function exampleSharedSubagentCatalog(
  contract: SharedSubagentCatalogContract,
): readonly string[] {
  // Settings renders one read-only row per built-in role; runtime execution stays in Core.
  return contract.agents.map((agent) => agent.name);
}
