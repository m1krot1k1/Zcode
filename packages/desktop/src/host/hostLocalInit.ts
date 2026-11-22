import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  HostResponseTypes,
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  ICredentialService,
  IProjectService,
  IRemoteProjectService,
  ISettingService,
  ISourceServerManagementService,
  IZCodeAgentService,
  IZCodeTaskService,
  type RemoteProjectHost,
} from "@zcode/services";
import {
  bindRemoteProjectIdentities,
  createHostApiNetworkTransport,
  createLocalServices,
  createRemoteProjectConnectionAdmission,
  createSettingServiceWithMigrations,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
} from "@zcode/services/node";
import { createHostDatabaseStartup } from "./database-startup/hostDatabaseStartup.js";
import { createSourceServerManagementService } from "./sourceServerManagementService.js";
import { resolveBotRemoteWorkspace } from "./botRemoteWorkspaceResolver.js";
import { resolveServerProjectService } from "./remoteWorkspaceServiceCollection.js";
import { SourceServerConnectionManager } from "./sourceServerConnectionManager.js";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createReportingRemoteZCodeTaskService, warmUpZCodeAgent } from "./hostTaskReporting.js";
import { dispatchManualAutomationRun } from "./hostCronDispatch.js";
import {
  createFullFeedbackLogArchiveViaMain,
  authorizeLocalMediaPreviewPath,
  logger,
} from "./hostProcessLogging.js";
import { browserControlMainBridge, pluginSandboxRegistrationBridge } from "./hostProcessBridges.js";
import {
  cuaOperationStateReporter,
  runtimeProcessLifecycleReporter,
  runtimeTaskReporter,
} from "./hostTaskReporting.js";
import { attachmentRegistry, hostState, remoteRegistry } from "./hostState.js";
import {
  notifyProjectChange,
  resolveBotProjectConnection,
  wireLocalResourceTelemetry,
} from "./hostSourceServices.js";
import { logWindowHostTopology } from "./hostWindowRuntime.js";
import type { HostIncomingMessage } from "./hostMessagePortGuard.js";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "./remoteDynamicWorkflowUserMode.js";
import { resolveSourceServerReleaseAsset } from "./sourceServerReleaseResolver.js";
import { runStartupReconnectBatch } from "./sourceServerStartupReconnect.js";
import { shouldDetachSourceSettingsAttachment } from "./sourceSettingsServiceCollection.js";

const { parentPort } = process;

type InitLocalMessage = Extract<HostIncomingMessage, { type: typeof HostMessageTypes.InitLocal }>;

/** init-local：装配本地 services、Source Manager 与 base attachment。 */
export async function initializeLocalHost(
  msg: InitLocalMessage,
  port: Electron.MessagePortMain | undefined,
): Promise<void> {
  if (!port) {
    logger.error("init-local message missing MessagePort");
    return;
  }
  if (hostState.databaseStartup) {
    port.close();
    hostState.databaseStartup.coordinator.publish();
    return;
  }
  let basePortClosed = false;
  port.once("close", () => {
    basePortClosed = true;
  });
  hostState.databaseStartup = createHostDatabaseStartup({
    startupId: msg.databaseStartupId,
    cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
    workingDirectories:
      msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
      (msg.workspacePath ? [msg.workspacePath] : []),
    env: msg.runtimeProcessEnvPatch,
    publish: (state) => {
      parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
      if (state.phase === "ready") {
        for (const attach of hostState.pendingStartupAttachments.values()) {
          try {
            attach();
          } catch (error) {
            logger.warn("startup attachment failed", error);
          }
        }
        hostState.pendingStartupAttachments.clear();
      }
    },
    onFailure: (error) =>
      logger.error(
        `local database startup failed attempt=${hostState.databaseStartup?.coordinator.snapshot.attemptId}`,
        error,
      ),
    onTiming: (phase, durationMs) => logger.info("database startup phase", { phase, durationMs }),
    initializeServices: async () => {
      logger.info("initializing local services");
      // 旧 Team 补组织必须与网络代理读取共用同一个 Setting 实例及写队列。
      // 只注入 service 会跳过默认装配分支，导致缺组织的升级用户永远无法恢复连接。
      const {
        service: settingService,
        prepareLegacyAccountConnections,
        setWorkspaceProjection,
      } = createSettingServiceWithMigrations();
      const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
        const settings = await settingService.get();
        return {
          httpProxy: settings.httpProxy,
          noProxy: settings.httpProxyNoProxy,
          caCertPath: settings.httpProxyCaCertPath,
        };
      });
      const services = await initializeHostApiNetworkTransportOwner({
        transport: hostApiNetworkTransport,
        log: (message, details) => logger.warn(message, details),
        establishOwner: () => {
          const initializedServices = createLocalServices({
            enableOpenCodeAcpRuntime: true,
            reportPluginTelemetryEvent: (event) => {
              parentPort?.postMessage({
                type: HostResponseTypes.PluginTelemetry,
                event: {
                  ...event,
                  context: {
                    ...event.context,
                    screenResolution: event.context.screenResolution || "unknown",
                  },
                },
              });
            },
            resolveBotProjectConnection,
            resolveBotRemoteWorkspace: (workspace) =>
              hostState.sourceServerDirectory
                ? resolveBotRemoteWorkspace(workspace, "lookup", {
                    directory: hostState.sourceServerDirectory,
                    listSessions: () => remoteRegistry().listSessions(),
                  })
                : Promise.resolve(null),
            setWorkspaceProjection,
            remoteProjectConnection: {
              connectHost: async (host) => {
                if (host.target?.kind === "server") {
                  const connected = await remoteRegistry().connectSource({
                    target: host.target,
                    remoteAssets: msg.remoteAssets ?? {},
                    membershipIntent: "retain",
                  });
                  return remoteProjectHostIdForTarget(host.target, connected.sourceServerId);
                }
                if (!hostState.sourceServerManagementService)
                  throw new Error("remote-project.connector-unavailable");
                const management = hostState.sourceServerManagementService;
                const snapshot = await management.getSnapshot();
                const profiles = snapshot.profiles.filter(
                  (profile) =>
                    profile.lifecycleState !== "retired" &&
                    remoteProjectHostIdForProfile(profile) === host.id,
                );
                const preferred = new Set(
                  snapshot.servers.map((server) => server.preferredProfileId),
                );
                const profile =
                  profiles.find((item) => preferred.has(item.profileId)) ?? profiles[0];
                if (!profile) throw new Error("remote-project.profile-not-found");
                const connected = await management.connectProfile(profile.profileId, {
                  retainedOnly: true,
                });
                const resolved = connected.profiles.find(
                  (item) => item.profileId === profile.profileId,
                );
                if (
                  !resolved ||
                  !connected.states.some(
                    (state) => state.profileId === resolved.profileId && state.state === "online",
                  )
                )
                  throw new Error("project.host-offline");
                return remoteProjectHostIdForProfile(resolved);
              },
              readConnectionStates: async () => {
                const result = new Map<
                  string,
                  Pick<
                    RemoteProjectHost,
                    | "connectionStatus"
                    | "lastConnectionError"
                    | "lastConnectionStatus"
                    | "upgradeTarget"
                  >
                >();
                for (const state of remoteRegistry().listConnections()) {
                  if (state.target.kind !== "server") continue;
                  result.set(remoteProjectHostIdForTarget(state.target, state.sourceServerId), {
                    connectionStatus:
                      state.state === "online"
                        ? "online"
                        : state.state === "connecting"
                          ? "connecting"
                          : "offline",
                  });
                }
                if (!hostState.sourceServerDirectory || !hostState.sourceServerConnectionManager)
                  return result;
                const snapshot = await hostState.sourceServerDirectory.snapshot();
                for (const state of hostState.sourceServerConnectionManager.listStates()) {
                  const profile = snapshot.profiles.find(
                    (item) => item.profileId === state.profileId,
                  );
                  if (!profile) continue;
                  const id = remoteProjectHostIdForProfile(profile);
                  const value =
                    state.state === "online"
                      ? "online"
                      : ["bootstrapping", "retrying", "updating"].includes(state.state)
                        ? "connecting"
                        : "offline";
                  if (
                    result.get(id)?.connectionStatus !== "online" &&
                    (result.get(id)?.connectionStatus !== "connecting" || value === "online")
                  )
                    result.set(id, {
                      connectionStatus: value,
                      lastConnectionError: state.error,
                      lastConnectionStatus: state.state,
                      // 修复原因：投影曾丢掉 upgradeTarget，桌面端过旧时详情入口误显示“更新远端”。
                      upgradeTarget: state.upgradeTarget,
                    });
                }
                return result;
              },
            },
            resolveProjectHostService: async (hostId) => {
              const serverId = parseRemoteWorkspaceIdentity(
                buildRemoteHostWorkspaceIdentity(hostId, "/"),
              )?.sourceServerId;
              const registered = serverId ? remoteRegistry().getOnlineSource(serverId) : undefined;
              if (registered && serverId)
                return bindRemoteProjectIdentities(
                  registered.services.get(IProjectService),
                  async (workspacePath) => {
                    const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
                      serverId,
                      workspacePath,
                    });
                    await registered.capabilities?.bindWorkspaceIdentity?.({
                      workspacePath,
                      stableWorkspaceIdentity: workspaceIdentity,
                    });
                    return workspaceIdentity;
                  },
                );
              const source = hostState.sourceServerConnectionManager?.listStates().find(
                (state) =>
                  state.sourceServerId &&
                  remoteHostIdFromWorkspaceIdentity(
                    buildServerRemoteWorkspaceIdentity({
                      serverId: state.sourceServerId,
                      workspacePath: "/",
                    }),
                  ) === hostId,
              );
              const connection = source?.sourceServerId
                ? hostState.sourceServerConnectionManager?.getOnlineConnection(
                    source.sourceServerId,
                  )
                : undefined;
              if (!connection || !source?.sourceServerId) throw new Error("project.host-offline");
              const sourceServerId = source.sourceServerId;
              return bindRemoteProjectIdentities(
                resolveServerProjectService({
                  connectionServices: connection.services,
                  serverId: sourceServerId,
                  virtualProjects: connection.serverInfo.capabilities.virtualProjects,
                  sourceServices: hostState.activeServices ?? undefined,
                }),
                async (workspacePath) => {
                  await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                    workspacePath,
                  });
                  return buildServerRemoteWorkspaceIdentity({
                    serverId: sourceServerId,
                    workspacePath,
                  });
                },
              );
            },
            parentPort,
            settingService,
            prepareLegacyAccountConnections,
            hostApiNetworkTransport,
            resolveClientLanguage: () => hostState.applicationLocale,
            authorizeLocalMediaPreviewPath,
            // launch.md「The user's choice」：本机用户选择变化后，推给本窗口所有在线的远程 Host。
            forwardDynamicWorkflowUserMode: (mode) => {
              void pushDynamicWorkflowUserModeToRemoteHosts(
                remoteRegistry()
                  .listReadyConnections()
                  .map(({ target, services: remoteServices }) => ({
                    target,
                    zcodeAgentService: remoteServices.get(IZCodeAgentService),
                  })),
                mode,
                (error) => logger.warn("remote dynamic workflow user mode forward failed", error),
              );
            },
            registerPluginSandbox: pluginSandboxRegistrationBridge.register,
            runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
            agentTelemetry: {
              getDeviceMid: () => msg.deviceMid,
              runtimeSurface: "desktop_local_host",
            },
            serviceAuthorityMode: "desktop-local",
            zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
            zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
            processLifecycleReporter: runtimeProcessLifecycleReporter,
            taskRuntimeReporter: runtimeTaskReporter,
            feedback: {
              getDeviceMid: () => msg.deviceMid,
              apiBaseUrl: msg.feedbackApiBase,
              createFullLogArchive: createFullFeedbackLogArchiveViaMain,
            },
            forwardSessionMessageSendRequested: (request) => {
              parentPort?.postMessage({
                type: HostResponseTypes.SessionMessageSendRequested,
                request,
              });
            },
            onAutomationManualRunRequested: dispatchManualAutomationRun,
            onOffPeakSchedulerWakeRequested: () => {
              parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
            },
            onProviderProvisioningSourceChanged: (trigger) => {
              parentPort?.postMessage({
                type: HostResponseTypes.ProviderProvisioningSourceChanged,
                trigger,
              });
            },
            // browser-use：agent 的 interaction/browserExecute 经 zcodeAgentService 转到这个 executor，
            // 再经 parentPort 到 main 的 WebContentsView+CDP 执行。
            browserControlExecutor: browserControlMainBridge,
            // CUA 顶部提示属于物理 Windows 桌面投影；非 Windows 和远端 authority 都不得上报。
            cuaOperationStateReporter:
              process.platform === "win32" ? cuaOperationStateReporter : undefined,
          });
          hostState.activeServices = initializedServices;
          hostState.activeHostApiNetworkTransport = hostApiNetworkTransport;
          return initializedServices;
        },
      });
      const zcodeTaskService = services.getOptional(IZCodeTaskService);
      if (zcodeTaskService) {
        const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(zcodeTaskService, {
          reportRunningPromptCount: false,
        });
        services.register(IZCodeTaskService, reportingZCodeTaskService);
      }
      hostState.sourceServerDirectory = new SourceServerDirectory({
        settingService: services.get(ISettingService),
        credentialService: services.get(ICredentialService),
        // host 域无 debug 日志通道；按 debug 语义仅在非生产输出，生产 no-op 防止刷盘。
        logDebug: (message) => {
          if (process.env.NODE_ENV !== "production") logger.info(message);
        },
      });
      hostState.sourceServerArtifactPolicy =
        msg.remoteAssets?.sourceServerArtifactPolicy ?? "release-versioned";
      // Bug 原因：release resolver 过去只传给 updateSource；启动恢复和 connectProfile 直接调用
      // Manager，在 development-content-addressed 同版本校验处拿不到本地 archive，必然误报 unavailable。
      const resolveSourceServerRelease = async (
        probe: Parameters<typeof resolveSourceServerReleaseAsset>[0],
        target: Parameters<typeof resolveSourceServerReleaseAsset>[2],
      ) => await resolveSourceServerReleaseAsset(probe, msg.remoteAssets ?? {}, target);
      hostState.sourceServerConnectionManager = new SourceServerConnectionManager({
        directory: hostState.sourceServerDirectory,
        admitConnection: createRemoteProjectConnectionAdmission(
          services.get(IRemoteProjectService),
        ),
        onProjectChange: notifyProjectChange,
        logWarn: (message, error) => logger.warn(message, error),
        sourceServerArtifactPolicy: hostState.sourceServerArtifactPolicy,
        resolveRelease: resolveSourceServerRelease,
      });
      hostState.sourceServerManagementService = createSourceServerManagementService({
        directory: hostState.sourceServerDirectory,
        manager: hostState.sourceServerConnectionManager,
        resolveRelease: resolveSourceServerRelease,
        onDirectorySnapshot: (snapshot) => {
          hostState.sourceServerDisplayNameById.clear();
          for (const server of snapshot.servers) {
            hostState.sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
          }
        },
        onBeforeSourceServerRemoved: async (sourceServerId) => {
          const hostId = remoteHostIdFromWorkspaceIdentity(
            buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
          );
          if (!hostId) throw new Error("remote-project.invalid-host-identity");
          await services.get(IRemoteProjectService).removeHost(hostId);
          attachmentRegistry().detachSourceSettingsAttachments(sourceServerId);
          hostState.sourceServerDisplayNameById.delete(sourceServerId);
        },
      });
      hostState.sourceSettingsStateSubscription =
        hostState.sourceServerConnectionManager.onDidChangeState((state) => {
          notifyProjectChange();
          if (state.sourceServerId && shouldDetachSourceSettingsAttachment(state.state)) {
            attachmentRegistry().detachSourceSettingsAttachments(state.sourceServerId);
          }
        });
      services.register(ISourceServerManagementService, hostState.sourceServerManagementService);
      wireLocalResourceTelemetry(services);
      hostState.hasDisposedHostResources = false;
      hostState.disposeHostResourcesInFlight = null;
      const agentWarmupTargets =
        msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
          ? msg.agentWarmupTargets
          : msg.workspacePath
            ? [
                {
                  workspacePath: msg.workspacePath,
                  ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                },
              ]
            : [];
      // Main 已把启动预热限制为 active workspace 1 个；Host 必须显式消费这份固定名单，
      // 不能让后续 task-list observer 再隐式扩大，也不能因失败扫描补位。
      agentWarmupTargets.forEach((target, index) => {
        warmUpZCodeAgent(
          services,
          target,
          `local host init (${index + 1}/${agentWarmupTargets.length})`,
        );
      });
      logger.info("exposing services on ChannelServer...");
      if (!basePortClosed)
        attachmentRegistry().attach({
          requestId: `init-local-${randomUUID()}`,
          attachmentId: `base-${randomUUID()}`,
          clientMode: "desktop-continuous",
          scope: { kind: "local" },
          port,
        });
      logWindowHostTopology("base-attachment-ready");
      logger.info("local services ready, all channels registered");
      // URL Host 复用相同启动开关与 Registry；项目发现不创建 logical workspace/Agent。
      void runStartupReconnectBatch({
        getSettings: () => services.get(ISettingService).get(),
        listCandidates: async () =>
          (await services.get(IRemoteProjectService).readDirectory()).hosts.filter(
            (host) => host.kind === "server",
          ),
        reconnect: (hosts) =>
          Promise.all(
            hosts.map(async (host) => {
              try {
                await services.get(IRemoteProjectService).connectHost(host.id);
              } catch (error) {
                logger.warn("URL Server startup reconnect failed", { hostId: host.id, error });
              }
            }),
          ),
      }).catch((error) => logger.warn("URL Server startup directory unavailable", error));

      // Bug 原因：Directory 迁移属于远程附加能力，等待它完成会把本地 base attachment 的
      // 首帧一起拖住。base ready 后再后台初始化；失败 flight 清空，用户显式连接仍可重试。
      void hostState.sourceServerDirectory
        .initialize()
        .then(async () =>
          runStartupReconnectBatch({
            getSettings: () => services.get(ISettingService).get(),
            listCandidates: async () => {
              const retained = new Set(
                (await services.get(IRemoteProjectService).readDirectory()).hosts.map(
                  (host) => host.id,
                ),
              );
              return (
                await hostState.sourceServerDirectory!.listStartupReconnectCandidates()
              ).filter((candidate) =>
                retained.has(remoteProjectHostIdForProfile(candidate.profile)),
              );
            },
            reconnect: (candidates) =>
              hostState.sourceServerConnectionManager!.reconnectOnStartup(candidates),
          }),
        )
        .then((results) => {
          const online = results.filter((result) => result.status === "online").length;
          // Bug 原因：过去只记录失败计数，真实 Profile/reason 被吞掉，导致冷启动失败只能靠
          // 手动重连再次触发。启动批次最多 3 个，逐项 warn 不会形成高频日志。
          for (const result of results) {
            if (result.status === "failed") {
              logger.warn("Source Server startup reconnect failed", {
                profileId: result.profileId,
                error: result.error,
              });
            }
          }
          logger.info(
            `Source Server startup reconnect finished, online=${online}, failed=${results.length - online}`,
          );
        })
        .catch((error) =>
          logger.warn(
            "Source Server directory initialization failed; local services remain available",
            error,
          ),
        );
    },
  });
  await hostState.databaseStartup.coordinator.start();
}
