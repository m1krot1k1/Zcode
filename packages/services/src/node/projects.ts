// Проектный слой: проекция workspace-настроек, remote/local project service,
// группы задач и подготовка исполнения сессий.
import type { BuildContext, CoreServices } from "./bundles.js";
import { createProjectService } from "#src/project/index.js";
import {
  createRemoteProjectService,
  projectWorkspaceSettings,
  readRemoteProjectDirectory,
} from "#src/remote-projects/index.js";
import { createTaskGroupService, groupTaskKey } from "#src/task-groups/index.js";
import { join } from "node:path";
import { getZCodeDataRootDir as projectDataRoot } from "#src/paths.js";

export function createProjectServices(args: BuildContext & CoreServices) {
  const { options, settingService, localSettings, taskIndexRepo, systemService, fileService } =
    args;
  const { broadcastService } = args;
  const setWorkspaceProjection =
    options?.setWorkspaceProjection ?? localSettings?.setWorkspaceProjection;
  setWorkspaceProjection?.(async (settings) => {
    const db = await taskIndexRepo.getOrganizationDatabase();
    const repository = await taskIndexRepo.getProjectRepository();
    db.exec("BEGIN");
    try {
      const directory =
        !options?.projectStorageHostId || options.projectStorageHostId === "local"
          ? readRemoteProjectDirectory(db)
          : { hosts: [], entries: [] };
      const projection = projectWorkspaceSettings(
        repository.readTree({ includeTasks: false }).projects,
        directory,
        settings,
      );
      db.exec("COMMIT");
      return projection;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  });
  const publishProjectChange = async () => {
    // SQLite 已提交；旧字段只能在设置 owner 的锁内从最新目录派生。
    if (setWorkspaceProjection) await settingService.update({});
    await broadcastService.send({ channel: "state:projects", payload: {} });
  };
  const remoteProjectService = createRemoteProjectService({
    ...options?.remoteProjectConnection,
    controller: !options?.projectStorageHostId || options.projectStorageHostId === "local",
    database: () => taskIndexRepo.getOrganizationDatabase(),
    afterChange: publishProjectChange,
  });
  const projectService = createProjectService({
    directories: {
      home: async () => (await systemService.info()).homedir,
      read: (params) => fileService.readdir(params),
    },
    ownerHostId: options?.projectStorageHostId,
    resolveHost: options?.resolveProjectHostService,
    repository: () => taskIndexRepo.getProjectRepository(),
    workspaceDirectory: join(projectDataRoot(), "workspace"),
    afterChange: publishProjectChange,
  });
  const taskGroupService = createTaskGroupService({
    database: () => taskIndexRepo.getOrganizationDatabase(),
    resolveTasks: async (refs) => {
      // 只读所属 Host 的权威目录；项目路由不会为分组建立连接或启动 Agent。
      const hostIds = [...new Set(refs.map((task) => task.hostId))];
      const results = await Promise.all(
        hostIds.map(async (hostId) => {
          const tree = await projectService.readTree({
            hostId,
            includeDeletedTasks: true,
          });
          const facts = new Map(
            [
              ...tree.tasks,
              ...(tree.deletedTasks ?? []).map((task) => ({
                ...task,
                deleted: true,
              })),
            ].map((task) => [groupTaskKey(task), task]),
          );
          return refs
            .filter((ref) => ref.hostId === hostId)
            .flatMap((ref) => {
              const fact = facts.get(groupTaskKey(ref));
              return fact && fact.hostId === ref.hostId && fact.workspacePath === ref.workspacePath
                ? [{ ...fact, ...ref }]
                : [];
            });
        }),
      );
      return results.flat();
    },
    afterChange: () => broadcastService.send({ channel: "state:task-groups", payload: {} }),
  });
  const prepareProjectExecution = async (projectId: string) => ({
    ...(await projectService.prepareSession({ projectId })),
    hostId: options?.projectStorageHostId ?? "local",
    workspaceIdentity: undefined,
  });
  return {
    setWorkspaceProjection,
    publishProjectChange,
    remoteProjectService,
    projectService,
    taskGroupService,
    prepareProjectExecution,
  };
}
