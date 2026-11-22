/**
 * zcodeAgentProcessManager.ts: Публичный API менеджера процессов агента.
 *
 * Реализация разложена по модулям в `./process-manager/`:
 * - `types` — контракты команды, опций и состояния managed-процесса;
 * - `commandResolver` — резолвинг команды (env → monorepo → Electron → binary),
 *   preflight cwd/command и dev stdio-tap proxy;
 * - `coverageEnv` — E2E-preload сбора покрытия CLI;
 * - `diagnostics` — редактирование секретов и ограниченный tail stderr;
 * - `lifecycleBase` — единственный владелец пула процессов, generation/identity,
 *   idle-таймеров, reclaim и dispose;
 * - `processManager` — spawn-оркестрация и подписки на exit/timeout/close.
 */
export {
  buildE2EAgentCoverageEnv,
  resolveDefaultZCodeAgentCommand,
  wrapZCodeAgentCommandWithStdioTapDevProxy,
  ZCodeAgentProcessManager,
} from "./process-manager/index.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./process-manager/index.js";
