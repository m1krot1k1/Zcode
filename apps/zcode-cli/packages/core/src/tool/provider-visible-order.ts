const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  // ApplyPatch/MultiEdit — универсальные файловые инструменты, доступные всем моделям
  // (снятие модельного гейта F-03); держим их в отсортированном стабильном префиксе,
  // чтобы промпт-кэш не инвалидировался от порядка регистрации.
  "ApplyPatch",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "MultiEdit",
  "NotebookEdit",
  "PtySession",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  return [
    ...referenceTools.sort((left, right) => left.name.localeCompare(right.name)),
    ...localTools,
  ];
}
