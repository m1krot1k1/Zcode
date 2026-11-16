import { normalizeAgentProfiles, type AgentProfile } from "./profile.js";
import type { TraceContext } from "@zcode/contracts";

export interface AgentDefinitionsSnapshot {
  readonly activeAgents: readonly Readonly<AgentProfile>[];
}

/** 同步读取已发布的内存快照；加载、覆盖和移除由提供方负责。 */
export type GetAgentDefinitions = () => AgentDefinitionsSnapshot;

export type LoadAgentDefinitions = (input: {
  signal: AbortSignal;
  traceContext: TraceContext;
}) => Promise<AgentDefinitionsSnapshot>;

/** 新父上下文替换快照；加载失败由 turn 收尾，不能吞掉断连错误后继续请求模型。 */
export function createTurnAgentDefinitions(
  getInitial: GetAgentDefinitions,
  load?: LoadAgentDefinitions,
  reload?: LoadAgentDefinitions,
) {
  let snapshot: AgentDefinitionsSnapshot | undefined;
  const apply = async (
    loader: LoadAgentDefinitions | undefined,
    input: Parameters<LoadAgentDefinitions>[0],
  ): Promise<void> => {
    if (!loader) return;
    const next = await loader(input);
    input.signal.throwIfAborted();
    snapshot = structuredClone(next);
  };
  return {
    get: (): AgentDefinitionsSnapshot => snapshot ?? getInitial(),
    async prepare(input: Parameters<LoadAgentDefinitions>[0]): Promise<void> {
      await apply(load, input);
    },
    /** Явный refresh после subagent-factory/plugin install, не привязанный к turn start. */
    async reload(input: Parameters<LoadAgentDefinitions>[0]): Promise<void> {
      await apply(reload, input);
    },
  };
}

export function createAgentDefinitionsReader(
  profiles: readonly AgentProfile[],
  options: Parameters<typeof normalizeAgentProfiles>[1] = {},
): GetAgentDefinitions {
  const snapshot: AgentDefinitionsSnapshot = {
    activeAgents: normalizeAgentProfiles(profiles, options),
  };
  return () => snapshot;
}
