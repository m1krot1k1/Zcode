/**
 * Публичный API subagent runtime. Реализация разнесена по `./subagent/*`:
 * spawn envelope, модельные фабрики, tool policy, MCP/Computer Use preflight и сборка порта.
 */
import type { SubagentPort } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { createDefaultSubagentPort as createDefaultSubagentPortImpl } from "./subagent/port.js";

export { buildSpawnEnvelope, resolveSubagentTaskTimeoutMs } from "./subagent/spawn-envelope.js";
export {
  createInheritedSubagentModelFactory,
  modelSelectionFromActiveModel,
} from "./subagent/model-factory.js";
export {
  resolveRuntimeDelegationToolNames,
  resolveSubagentToolAllowlist,
} from "./subagent/child-tool-policy.js";

/**
 * Обёртка вместо re-export: `methods/index.ts` присваивает этот символ прототипу во время
 * циклической инициализации `agent-runtime → methods/index → subagent`. Function declaration
 * инициализируется на этапе линковки модуля, тогда как indirect re-export в этот момент ещё
 * не разрешён и даёт `undefined`.
 */
export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  return createDefaultSubagentPortImpl.call(this, deps);
}
