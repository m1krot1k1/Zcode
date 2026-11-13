/**
 * zcodeTaskServiceAdapterTaskSettingsMethods.ts: Методы IZCodeTaskService: импорт сессий и настройки задачи.
 */
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import type {
  ZCodeConfigOption,
  ZCodeImportSessionsResult,
  ZCodeTaskMode,
  ZCodeTaskTokenUsageResult,
} from "@zcode/shared";
import { readModelTrajectory } from "./modelTrajectory.js";
import {
  MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  settingsToConfigOptions,
  THOUGHT_LEVEL_CONFIG_ID,
} from "./zcodeConfigOptions.js";
import {
  GLM_PROVIDER,
  logger,
  resolveZCodeAgentCurrentLogFilePath,
} from "./zcodeTaskServiceAdapterCore.js";
import {
  normalizeWorkspaceParams,
  parseModelPickerValue,
  toZCodeMode,
} from "./zcodeTaskServiceAdapterSnapshotSupport.js";
import { createSessionTraceId, resolveWorkspaceKey } from "@zcode/shared";
import { importClaudeNativeSessions } from "#src/session/claude-native/claudeNativeSessionImportService.js";
import { existsSync } from "node:fs";

export function createTaskSettingsMethods(
  context: TaskAdapterContext,
): Pick<
  IZCodeTaskService,
  | "importClaudeSessions"
  | "setMode"
  | "setConfigOption"
  | "setModel"
  | "setAutomationSessionConfig"
  | "getWorkspaceProviderConfigFile"
  | "getTaskNativeSessionLogFile"
  | "getModelTrajectory"
  | "getTaskTokenUsage"
  | "getTaskSessionFilePath"
  | "restartWorkspaceProcess"
> {
  const {
    taskIndexRepo,
    emitWorkspaceTaskListChanged,
    getTaskTarget,
    recoverRuntimeStateAfterRuntimeLoss,
    rememberIndexedTaskMeta,
    resumeSnapshot,
    sendConfigCasCommandV4,
    switchCollaborationModeViaProtocol,
    syncTaskIndexSnapshot,
    updateIndexedPresentation,
    options,
  } = context;
  return {
    async importClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      sessionIds: string[];
    }): Promise<ZCodeImportSessionsResult> {
      return importClaudeNativeSessions({
        taskIndexRepo,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionIds: params.sessionIds,
        createImportedSession: async (source) => {
          const targetWorkspaceIdentity = params.workspacePath
            ? params.workspaceIdentity
            : undefined;
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: source.workspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            // 显式重新导入产生新 CLI 会话，不能用来源 hash 覆盖已删除或已继续对话的记录。
            sessionTraceId: createSessionTraceId(),
            persistence: "immediate",
            importedHistory: {
              source: "claudeCode",
              title: source.title,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
              messages: source.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          // 导入后的任务必须是真实 ZCode session，setModel/sendPrompt 才能继续命中 runtime。
          // 同时保留 migrationSource，避免任务列表把 Claude Code 迁移历史当成本地新会话。
          return updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
        },
        onTaskImported: (meta) => {
          rememberIndexedTaskMeta(meta);
          emitWorkspaceTaskListChanged(
            {
              workspacePath: meta.workspacePath,
              workspaceIdentity: meta.workspaceIdentity,
              taskId: meta.taskId,
            },
            meta,
            // 导入沿用 task_meta_changed 旧语义。
            "task_meta_changed",
          );
        },
      });
    },

    async setMode(params): Promise<void> {
      // session/setMode → v4 switchCollaborationMode（CAS，revision 收敛见
      // sendHostCasCommandV4）。v4 handler 不发旧 state.updated，观察端一致性与桌面
      // v4 工具条切换同批（读路径 v4 store 收口）；发起端由下方 resumeSnapshot 保真。
      const target = getTaskTarget(params.taskId);
      await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
    },

    async setConfigOption(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      if (params.configId === MODEL_CONFIG_ID) {
        return context.service.setModel({
          taskId: params.taskId,
          traceId: params.traceId,
          modelSelection: parseModelPickerValue(params.value),
        });
      }
      if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
        // session/setThoughtLevel → v4 switchModelConfig（v4 无独立思考深度命令，
        // thought 字段承载；provider/model 取当前会话选型，与桌面 v4 工具条同一命令面）。
        // 同 provider 同 model 直切，不涉及 runtimeModel（provider 凭据）解析——这正是
        // setModel 尚不能迁移的原因（见下方 setModel 标注）。
        const current = await options.zcodeAgentService.readSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
        });
        const model = current.settings.model.current;
        // 未绑定会话可以查看，但单独切档位不能猜测 Provider/Model。
        if (!model) throw new Error("请先选择模型，再设置思考档位");
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: params.value,
          },
          `session=${params.taskId} thought=${params.value}`,
        );
      } else if (params.configId === MODE_CONFIG_ID) {
        await switchCollaborationModeViaProtocol(
          target,
          toZCodeMode(params.value as ZCodeTaskMode) ?? "build",
        );
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setModel(params): Promise<ZCodeConfigOption[]> {
      // replayable facade 仍依赖 legacy op 返回的 Session
      // Snapshot；模型执行事实已经收敛到目标 Worker Registry，Host 只发送 Selection。
      // 过渡归宿 = task facade 原生消费 V4 config 投影与 revision。
      const target = getTaskTarget(params.taskId);
      await options.zcodeAgentService.setModel({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        // replayable/legacy facade 的 modelId 可能只是 UI 运行态模型名（如 gpt-5.5）。
        // 多个自定义 provider 同名时只能信任 UI 传入的结构化 ModelSelection。
        model: params.modelSelection,
      });
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setAutomationSessionConfig(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      const model = params.modelSelection;
      const thoughtLevel = params.thoughtLevel?.trim() ?? "";
      // automation 过去先走 legacy session/setModel，再发 V4 Think。若目标模型
      // 已带相同默认 Think，第二步会 noop 且不产 ModelSelected，导致 runtime 已切换但
      // conversation 投影仍显示旧模型。这里用一条 V4 命令原子更新 runtime 与投影。
      await sendConfigCasCommandV4(
        target,
        "switchModelConfig",
        {
          provider: model.providerId,
          model: model.modelId,
          thought: thoughtLevel,
        },
        `automation session=${params.taskId} model=${model.providerId}/${model.modelId} thought=${thoughtLevel}`,
      );
      if (thoughtLevel) {
        // 跨模型 switchModelConfig 会先采用目标模型默认 Think，避免误用源模型档位。
        // automation 的 thought 已由创建/编辑表单按目标模型校验，可在模型事件落地后
        // 再以同模型命令显式收敛；同默认值时 noop，非默认值时发布第二个 config delta。
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: thoughtLevel,
          },
          `automation session=${params.taskId} thought=${thoughtLevel}`,
        );
      }
      if (params.mode?.trim()) {
        await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async getWorkspaceProviderConfigFile(params) {
      return {
        provider: GLM_PROVIDER,
        path: params.workspacePath,
        exists: false,
      };
    },

    async getTaskNativeSessionLogFile() {
      const path = resolveZCodeAgentCurrentLogFilePath();
      // 返回 ZCode Agent 的结构化日志 JSONL；日志行中的 sessionId 用于按当前任务排查。
      return { provider: GLM_PROVIDER, path, exists: existsSync(path) };
    },

    async getModelTrajectory(params) {
      // ZCode Agent 把 taskId 当作 sessionId 落盘 model-io（见本文件其它 sessionId: params.taskId 用法），
      // 这里按 sessionId 还原该 task 的模型调用轨迹，供 UI 侧边栏可视化。
      const trajectory = await readModelTrajectory(params.taskId, params.limit);
      logger.info(
        `[ZCodeTaskService] getModelTrajectory taskId=${params.taskId} records=${trajectory.records.length} files=${trajectory.sourceFiles.length} truncated=${trajectory.truncated}`,
      );
      return trajectory;
    },

    async getTaskTokenUsage(params): Promise<ZCodeTaskTokenUsageResult> {
      // 摘要面板需要展示 task 的累计模型消耗，不能复用 usage_update 的 context window。
      // 这里通过 ZCode Protocol 读 agent SQLite 的 model_usage 聚合，保持桌面和远控同一事实源。
      return options.zcodeAgentService.getTaskTokenUsage({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.taskId,
      });
    },

    async getTaskSessionFilePath(params) {
      return {
        path: `${params.workspacePath}/${params.taskId}.zcode-session`,
        exists: false,
      };
    },

    async restartWorkspaceProcess(params): Promise<void> {
      // runtime 重启会丢弃 CLI 进程内的 turn；旧 active input/running 命令若不清，手机命令 drain 永久卡住。
      recoverRuntimeStateAfterRuntimeLoss(resolveWorkspaceKey(params));
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },
  };
}
