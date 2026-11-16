import type { Logger, PluginLoadOutcome } from "@zcode/contracts";
import { resolveZCodePlugins } from "../plugins.js";
import { filterVisualizeSkillRoots } from "./visualize-skill-gate.js";

export interface PluginRuntimeCatalogInput {
  initial: PluginLoadOutcome;
  env?: NodeJS.ProcessEnv;
  includeVisualize?: boolean;
  logger?: Logger;
  officialPluginRoots?: string[];
  pluginStorageRoot: string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory: string;
}

export interface PluginRuntimeCatalog {
  current(): PluginLoadOutcome;
  refresh(): Promise<PluginLoadOutcome>;
}

/**
 * Единственный владелец текущего plugin snapshot для живого runtime.
 *
 * Стартовый resolve читал config один раз. После install/enable/disable config на
 * диске уже другой, поэтому refresh обязан перечитать config, а не использовать
 * захваченный ConfigResult. Параллельные refresh делят один promise.
 */
export function createPluginRuntimeCatalog(
  input: PluginRuntimeCatalogInput,
): PluginRuntimeCatalog {
  let current = input.initial;
  let refreshPromise: Promise<PluginLoadOutcome> | undefined;

  return {
    current: () => current,
    refresh: () => {
      if (refreshPromise) return refreshPromise;
      refreshPromise = Promise.resolve()
        .then(() =>
          resolveZCodePlugins({
            env: input.env,
            logger: input.logger,
            officialPluginRoots: input.officialPluginRoots,
            pluginStorageRoot: input.pluginStorageRoot,
            ...(input.projectConfigPath ? { projectConfigPath: input.projectConfigPath } : {}),
            ...(input.skipUserConfig === undefined ? {} : { skipUserConfig: input.skipUserConfig }),
            ...(input.userConfigPath ? { userConfigPath: input.userConfigPath } : {}),
            workingDirectory: input.workingDirectory,
          }),
        )
        .then((next) => {
          const filtered: PluginLoadOutcome = {
            ...next,
            skillRoots: filterVisualizeSkillRoots(next.skillRoots, input.includeVisualize),
          };
          current = filtered;
          return filtered;
        })
        .finally(() => {
          refreshPromise = undefined;
        });
      return refreshPromise;
    },
  };
}
