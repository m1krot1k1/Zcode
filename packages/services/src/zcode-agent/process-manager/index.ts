/**
 * process-manager/index.ts: Публичный barrel менеджера процессов агента.
 *
 * Наружу отдаём только команду запуска, resolver-контракт, опции и сам manager;
 * внутренние группы (lifecycleBase / processManager / diagnostics / coverageEnv) —
 * деталь реализации.
 */
export { buildE2EAgentCoverageEnv } from "./coverageEnv.js";
export {
  resolveDefaultZCodeAgentCommand,
  wrapZCodeAgentCommandWithStdioTapDevProxy,
} from "./commandResolver.js";
export { ZCodeAgentProcessManager } from "./processManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./types.js";
