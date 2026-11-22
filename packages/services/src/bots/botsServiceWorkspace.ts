import type { BotTaskSelectionEntry, BotWorkspaceSelectionEntry } from "./botsServiceTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import { delay } from "./botsServiceOptions.js";
import { BOT_TASK_META_RETRY_DELAYS_MS, createOutbound } from "./botsServiceSupport.js";
import type { BotListWorkspaceRefsParams } from "./bots.js";
import {
  createWorkspaceRef,
  getWorkspaceKey,
  isWorkspaceAllowed,
  normalizeConfiguredAllowedWorkspaces,
} from "./workspaceHelpers.js";
import {
  type BotActor,
  type BotConfig,
  type BotContextState,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotWorkspaceRef,
  type BotsConfigFile,
  type Locale,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  type ProjectCatalogSnapshot,
  projectSelectionId,
  readProjectCatalog,
} from "#src/project-catalog/index.js";

export function createBotsServiceWorkspace(ctx: BotsServiceContext) {
  async function normalizeWorkspaceRef(workspace: BotWorkspaceRef): Promise<BotWorkspaceRef> {
    if (!workspace.workspaceIdentity || !ctx.deps.remoteWorkspaceService?.resolveWorkspace)
      return workspace;
    const resolved = await ctx.deps.remoteWorkspaceService.resolveWorkspace({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
    });
    if (
      !resolved ||
      (resolved.workspacePath === workspace.workspacePath &&
        resolved.workspaceIdentity === workspace.workspaceIdentity)
    )
      return workspace;
    return createWorkspaceRef(resolved.workspacePath, resolved.workspaceIdentity);
  }

  async function normalizeBotWorkspaceIdentities(bot: BotConfig): Promise<BotConfig> {
    // 只迁移 Host 已证明的远端 alias；未知 key 原样保留，绝不按相同路径扩大授权。
    const allowedWorkspaces = await Promise.all(
      bot.allowedWorkspaces.map(async (key) => {
        const parsed = parseRemoteWorkspaceIdentity(key);
        if (!parsed) return key;
        return (await normalizeWorkspaceRef(createWorkspaceRef(parsed.workspacePath, key))).id;
      }),
    );
    return { ...bot, allowedWorkspaces };
  }

  async function listWorkspaceRefs(
    _params: BotListWorkspaceRefsParams = {},
  ): Promise<BotWorkspaceRef[]> {
    return workspaceRefsFromCatalog(await readProjectCatalog(ctx.deps));
  }

  function workspaceRefsFromCatalog(catalog: ProjectCatalogSnapshot): BotWorkspaceRef[] {
    const foreign = new Set(catalog.directory.hosts.map((host) => host.id));
    return catalog.projects.map((project) => {
      const workspacePath =
        project.roots.find((root) => root.isPrimary)?.rootPath ?? project.roots[0]?.rootPath ?? "";
      return {
        id: projectSelectionId(project),
        label: project.name,
        projectId: project.id,
        hostId: project.hostId,
        workspacePath,
        rootPaths: project.roots.map((root) => root.rootPath),
        ...(foreign.has(project.hostId) && workspacePath
          ? { workspaceIdentity: buildRemoteHostWorkspaceIdentity(project.hostId, workspacePath) }
          : {}),
      };
    });
  }

  async function bindProject(
    workspace: BotWorkspaceRef,
  ): Promise<
    Pick<
      BotContextState,
      | "projectId"
      | "hostId"
      | "workspacePath"
      | "workspaceIdentity"
      | "workspaceId"
      | "additionalDirectories"
    >
  > {
    // 菜单只是展示快照。重新读取仍保留的项目，再由 owner 解析，迟到点击不能复活入口。
    const before = await readProjectCatalog(ctx.deps);
    const current = workspaceRefsFromCatalog(before).find((item) => item.id === workspace.id);
    if (!current?.projectId || !current.hostId)
      throw new Error("Bot project is no longer available");
    const execution = await ctx.deps.projectService.prepareSession({
      projectId: current.projectId,
      hostId: current.hostId,
    });
    const after = await readProjectCatalog(ctx.deps);
    const host = before.directory.hosts.find((item) => item.id === current.hostId);
    const retainedEntries = before.directory.entries.filter(
      (entry) =>
        entry.hostId === current.hostId &&
        (entry.projectId === current.projectId ||
          (entry.projectId === null &&
            entry.legacyWorkspace &&
            current.rootPaths?.includes(entry.legacyWorkspace.workspacePath))),
    );
    // 同一 ID 移除再添加也是新 admission；不能将旧 owner 的 prepare 结果保存为新绑定。
    if (
      !workspaceRefsFromCatalog(after).some((item) => item.id === current.id) ||
      (host &&
        (!after.directory.hosts.some(
          (item) => item.id === host.id && item.membershipId === host.membershipId,
        ) ||
          !retainedEntries.some((entry) =>
            after.directory.entries.some((item) => item.id === entry.id),
          )))
    )
      throw new Error("Bot project was removed during binding");
    return { ...execution, hostId: current.hostId, workspaceId: current.id };
  }

  function upgradeLegacyContext(
    context: BotContextState,
    catalog: ProjectCatalogSnapshot,
  ): BotContextState {
    const workspaces = workspaceRefsFromCatalog(catalog);
    const identity = context.workspaceIdentity;
    // 历史 canonical key 是执行身份，不能直接当作新 Source 的持库 host ID。
    const legacyHostId = catalog.directory.entries.find(
      (entry) =>
        entry.legacyWorkspace?.workspaceIdentity === identity &&
        entry.legacyWorkspace?.workspacePath === context.workspacePath,
    )?.hostId;
    const hostId = identity
      ? (legacyHostId ?? remoteHostIdFromWorkspaceIdentity(identity))
      : (ctx.deps.ownerHostId ?? "local");
    const candidates = workspaces.filter(
      (workspace) =>
        workspace.rootPaths?.includes(context.workspacePath) &&
        (identity
          ? workspace.hostId === hostId || workspace.workspaceIdentity === identity
          : !workspace.workspaceIdentity),
    );
    // 旧 path-only 远端只在唯一候选时补身份；已有 cwd 永远不跟随项目主要目录。
    const legacyRemote =
      !identity && candidates.length === 0
        ? workspaces.filter((workspace) => workspace.rootPaths?.includes(context.workspacePath))
        : [];
    const selected =
      candidates.length === 1
        ? candidates[0]
        : legacyRemote.length === 1
          ? legacyRemote[0]
          : undefined;
    const resolvedHostId = selected?.hostId ?? hostId ?? ctx.deps.ownerHostId ?? "local";
    const workspaceIdentity =
      identity ??
      (selected?.workspaceIdentity && selected.hostId
        ? buildRemoteHostWorkspaceIdentity(selected.hostId, context.workspacePath)
        : undefined);
    return {
      ...context,
      projectId: selected?.projectId ?? null,
      hostId: resolvedHostId,
      workspaceIdentity,
      workspaceId:
        selected?.id ??
        context.workspaceId ??
        getWorkspaceKey(context.workspacePath, workspaceIdentity),
      additionalDirectories: [],
    };
  }

  async function normalizeBotWorkspaceConfig(
    config: BotsConfigFile,
    bot: BotConfig,
    currentWorkspace?: BotWorkspaceRef,
  ): Promise<{
    config: BotsConfigFile;
    bot: BotConfig;
    user: BotConfig;
    workspaces: BotWorkspaceRef[];
  }> {
    const workspaces = await listWorkspaceRefs({ currentWorkspace });
    const nextAllowedWorkspaces = normalizeConfiguredAllowedWorkspaces(
      (await normalizeBotWorkspaceIdentities(bot)).allowedWorkspaces,
      workspaces,
    );
    const nextBot: BotConfig = {
      ...bot,
      // 旧路径授权只在项目候选唯一时交接；同 cwd 多项目不能扩大权限。
      allowedWorkspaces: nextAllowedWorkspaces,
    };
    const nextConfig: BotsConfigFile = {
      ...config,
      bots: config.bots.map((item) => (item.id === bot.id ? nextBot : item)),
    };
    const shouldWrite = nextBot.allowedWorkspaces.join("\n") !== bot.allowedWorkspaces.join("\n");
    if (shouldWrite) {
      await ctx.writeBotConfig(nextConfig);
    }
    return { config: nextConfig, bot: nextBot, user: nextBot, workspaces };
  }

  async function readTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
  ): Promise<ZCodeTaskMeta | null> {
    const zcodeTaskService = await ctx.resolveZCodeTaskServiceForContext(context);
    const tasks = await zcodeTaskService.listTasks({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    return tasks.find((task) => task.taskId === taskId) ?? null;
  }

  async function listContextTaskSelectionEntries(
    context: BotContextState,
    user: BotConfig,
  ): Promise<BotTaskSelectionEntry[]> {
    if (context.workspaceId && !isWorkspaceAllowed(context.workspaceId, user.allowedWorkspaces))
      return [];
    const tree = await ctx.deps.projectService.readTree({ hostId: context.hostId });
    const key = getWorkspaceKey(context.workspacePath, context.workspaceIdentity);
    return tree.tasks
      .filter(
        (task) =>
          task.projectId === (context.projectId ?? null) &&
          getWorkspaceKey(task.workspacePath, task.workspaceIdentity) === key,
      )
      .filter((task) => !context.group || context.group.taskIds.includes(task.taskId))
      .map((task) => ({
        task,
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }));
  }

  function resolvePendingTaskSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotTaskSelectionEntry | null {
    const actorContextKey = ctx.getActorContextKey(actor);
    const directEntry = ctx.pendingTaskSelectionsByContext.get(actorContextKey)?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = ctx.resolvePendingSelectionOption(actor, "task.set", value);
    if (!option) {
      return null;
    }
    return ctx.pendingTaskSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function resolvePendingWorkspaceSelectionEntry(
    actor: BotActor,
    value: string,
  ): BotWorkspaceSelectionEntry | null {
    const actorContextKey = ctx.getActorContextKey(actor);
    const directEntry = ctx.pendingWorkspaceSelectionsByContext
      .get(actorContextKey)
      ?.get(value.trim());
    if (directEntry) {
      return directEntry;
    }
    const option = ctx.resolvePendingSelectionOption(actor, "workspace.set", value);
    if (!option) {
      return null;
    }
    return ctx.pendingWorkspaceSelectionsByContext.get(actorContextKey)?.get(option.id) ?? null;
  }

  function createCurrentWorkspaceRef(context: BotContextState): BotWorkspaceRef {
    return {
      ...createWorkspaceRef(context.workspacePath, context.workspaceIdentity),
      id: context.workspaceId ?? getWorkspaceKey(context.workspacePath, context.workspaceIdentity),
      projectId: context.projectId ?? undefined,
      hostId: context.hostId,
    };
  }

  async function readContextActiveTaskMeta(
    context: BotContextState,
  ): Promise<ZCodeTaskMeta | null> {
    if (!context.activeTaskId) {
      return null;
    }
    const listedTask = await readTaskMeta(context, context.activeTaskId).catch(() => null);
    if (listedTask) {
      return listedTask;
    }
    return (
      (
        await (
          await ctx.resolveZCodeTaskServiceForContext(context)
        )
          .getTaskSnapshot({
            taskId: context.activeTaskId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
          })
          .catch(() => null)
      )?.meta ?? null
    );
  }

  async function requireActiveTask(
    message: BotInboundMessage,
    auth: {
      context: BotContextState;
      locale: Locale | undefined;
    },
  ): Promise<
    | {
        ok: true;
        taskId: string;
        task: ZCodeTaskMeta;
        configOptions: ZCodeConfigOption[];
      }
    | { ok: false; reply: BotOutboundMessage[] }
  > {
    if (!auth.context.activeTaskId) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))],
      };
    }
    const task = await readContextActiveTaskMeta(auth.context);
    if (!task) {
      return {
        ok: false,
        reply: [createOutbound(message.actor, ctx.msg(auth.locale, "noActiveTask"))],
      };
    }
    const configOptions = await ctx.listActiveTaskConfigOptions(
      auth.context,
      auth.context.activeTaskId,
    );
    return {
      ok: true,
      taskId: auth.context.activeTaskId,
      task,
      configOptions,
    };
  }

  async function broadcastTaskConfigSync(params: {
    context: BotContextState;
    taskId: string;
    task?: ZCodeTaskMeta | null;
    provider?: ZCodeProvider;
    configOptions?: ZCodeConfigOption[];
  }): Promise<void> {
    await ctx.broadcastTaskListChange(params.context, params.taskId, "updated", {
      ...(params.task ? { task: params.task } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.configOptions ? { configOptions: params.configOptions } : {}),
    });
  }

  function isTerminalTaskMeta(
    task: ZCodeTaskMeta | null,
    eventType: "task_complete" | "task_error",
  ): boolean {
    if (!task) {
      return false;
    }
    if (eventType === "task_error") {
      return task.status === "error";
    }
    return task.status === "completed";
  }

  async function readTerminalTaskMeta(
    context: Pick<BotContextState, "workspacePath" | "workspaceIdentity" | "hostId">,
    taskId: string,
    eventType: "task_complete" | "task_error",
  ): Promise<ZCodeTaskMeta | null> {
    let latestTask = await readTaskMeta(context, taskId).catch(() => null);
    if (isTerminalTaskMeta(latestTask, eventType)) {
      return latestTask;
    }

    for (const retryDelayMs of BOT_TASK_META_RETRY_DELAYS_MS) {
      await delay(retryDelayMs);
      latestTask = await readTaskMeta(context, taskId).catch(() => latestTask);
      if (isTerminalTaskMeta(latestTask, eventType)) {
        return latestTask;
      }
    }

    return latestTask;
  }

  return {
    normalizeWorkspaceRef,
    normalizeBotWorkspaceIdentities,
    listWorkspaceRefs,
    workspaceRefsFromCatalog,
    bindProject,
    upgradeLegacyContext,
    normalizeBotWorkspaceConfig,
    readTaskMeta,
    listContextTaskSelectionEntries,
    resolvePendingTaskSelectionEntry,
    resolvePendingWorkspaceSelectionEntry,
    createCurrentWorkspaceRef,
    readContextActiveTaskMeta,
    requireActiveTask,
    broadcastTaskConfigSync,
    isTerminalTaskMeta,
    readTerminalTaskMeta,
  };
}
