import type { ZCodeConfigOption, ZCodeSlashCommand } from "@zcode/shared";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import { getWorkspaceState, updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { updateActiveTaskConfigOptions } from "./active-task-config.js";
import { normalizeConfigOptions, updateCurrentModeConfigOption } from "./config-options.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createConfigActions(set: WorkspaceSliceSet) {
  return {
    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // 无 API key / 旧模型不可用时，工具栏 recovery effect 会多次提交同一份空模型配置。
          // 等价配置不应触发 workspace 级 store 通知，否则 ChatInputToolbar 会在 effect 中再次 setConfigOptions。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft 先保存 active task 的预热种子，随后异步目录水合会走到这里。
            // 目录刷新不是草稿生命周期终点，不能清掉种子，否则 createSession 会回退全局默认模型。
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // active task 运行态会忽略 workspace_config_options_update，
              // first-send/restore 又可能先写入只含 model 的 task 配置。
              // mode_update 是 session 事实源，必须同步补到 task 配置桶，否则发送后模式入口会消失。
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
