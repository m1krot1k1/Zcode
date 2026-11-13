import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type SessionCreateSource,
  type ZCodeProvider,
} from "@zcode/shared";
import { persistLastSelectedAgentProvider } from "@/lib/zcodeProviderPreference.js";
import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { cloneConfigOptions } from "./config-options.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createDraftActions(set: WorkspaceSliceSet) {
  return {
    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        projectId?: string | null;
        taskGroupId?: string | null;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;
      if (normalizedProvider) {
        persistLastSelectedAgentProvider(normalizedProvider);
      }

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // Bug 原因：protocol-v4 当前任务的配置可能只完成了 workspace 投影，
                  // legacy task 缓存尚未写入或仍是首帧空数组。此时工具条已经显示
                  // current.configOptions，新草稿必须从当前投影继承，不能无种子预热。
                  current.configOptions
              : null;
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            return {
              ...current,
              activeTaskId: null,
              composerInitialization: undefined,
              draftProjectId: options?.projectId,
              draftTaskGroupId: options?.taskGroupId,
              // 同 cwd 可属于多个项目；换项目不能复用前一个项目的预热 runtime 目录范围。
              draftRuntimeInvalidationVersion:
                current.draftRuntimeInvalidationVersion +
                Number(current.draftProjectId !== options?.projectId),
              draftCreateSource: options?.createSource ?? "session",
              draftRuntime: { status: "idle", error: null },
              // 从已有 task 点 New Task 时，草稿输入框必须继承当前 task 的完整配置。
              // 否则后续 workspace prepare 会按 Team Plan / 默认模型重建草稿，把已选的其他模型回弹成 GLM。
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N 或任务列表"新建任务"之前只切了 store 状态，没有显式把焦点交还给输入框。
              // Electron 菜单和按钮点击会先拿走焦点，导致用户看到草稿已打开，但光标要过一拍才回来。
              // 这里在每次进入草稿态时递增版本号，让 ChatView 能在状态切换完成后主动 focus 到 Lexical 输入框。
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // 新建任务态（taskId=null）现在也有自己的未发送草稿。
              // 这里切到草稿态时只重置“本次创建任务的瞬时状态”，不主动清空 null 作用域草稿，
              // 这样用户从 taskA/B/C 切回“新建任务”时，才能继续编辑刚才没发出去的内容。
              // 新建草稿如果继续沿用上一条会话的 slashCommands，输入 `/` 时会看到旧任务遗留的命令。
              // 但以前这里每次“新建任务”都无条件清空，草稿态重复点击会把命令列表清空且不会触发回填。
              // 仅在“从 task 切到 draft”或“provider 真正切换”时清空，避免同草稿态重复点击误伤。
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // 某些“新建任务”入口会把当前 selectedProvider 透传回 startDraft。
                    // 如果 provider 实际没变化却强制重置 supplier，会出现“显示 custom 模型但 custom 选项被锁”的撕裂态。
                    // 这里只在 provider 真正切换时才回到 native，避免同 provider 新建草稿误伤现有 supplier 上下文。
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
