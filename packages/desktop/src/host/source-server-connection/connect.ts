import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type {
  ServerRemoteConnection,
  ServerRemoteDuplexConnectionOptions,
} from "../serverRemoteConnection.js";
import type { TransportContext } from "@zcode/server/source-server";
import { getAdapter } from "./adapters.js";
import { buildCompatibilityState } from "./compatibility.js";
import { clearRecoveryTimers, handleUnexpectedClose } from "./recovery.js";
import { rememberSourceProfiles, setState } from "./state.js";
import {
  SourceServerHandshakeClosedError,
  SourceServerIdentityChangePendingError,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
  type ConnectFlight,
  type ConnectSourceServerOptions,
  type ManagedSourceServerConnection,
  type ManagerContext,
  type OnlineConnection,
} from "./types.js";

export async function connect(
  ctx: ManagerContext,
  options: ConnectSourceServerOptions,
): Promise<ManagedSourceServerConnection> {
  return await connectForSource(
    ctx,
    { ...options, membershipIntent: options.membershipIntent ?? "add" },
    options.profile.sourceServerId,
  );
}

export function reusedConnection(
  ctx: ManagerContext,
  connection: ManagedSourceServerConnection,
): ManagedSourceServerConnection {
  const target = ctx.reconnectInputs.get(connection.sourceServerId)?.target;
  return {
    sourceServerId: connection.sourceServerId,
    profileId: connection.profileId,
    serverInfo: connection.serverInfo,
    services: connection.services,
    ...(target ? { reusedConnectionTarget: stripRemoteTargetSecrets(target) } : {}),
  };
}

export async function connectForSource(
  ctx: ManagerContext,
  options: ConnectSourceServerOptions,
  sourceServerId: string | undefined,
  recordOperation = true,
): Promise<ManagedSourceServerConnection> {
  const existingFlight = ctx.connectFlights.get(options.profile.profileId);
  if (existingFlight) return reusedConnection(ctx, await existingFlight.promise);
  const controller = new AbortController();
  const flightOptions = sourceServerId
    ? {
        ...options,
        context: {
          ...options.context,
          signal: options.context?.signal
            ? AbortSignal.any([options.context.signal, controller.signal])
            : controller.signal,
        },
      }
    : options;
  let flight!: ConnectFlight;
  const connectOnceForContext = (context: TransportContext) =>
    connectOnce(ctx, { ...flightOptions, context }, controller.signal);
  const promise = (
    recordOperation
      ? ctx.operationLogs.run(
          "connect",
          options.profile,
          options.target,
          flightOptions.context,
          connectOnceForContext,
        )
      : connectOnceForContext(flightOptions.context ?? {})
  ).finally(() => {
    if (ctx.connectFlights.get(options.profile.profileId) === flight) {
      ctx.connectFlights.delete(options.profile.profileId);
    }
  });
  flight = {
    promise,
    ...(sourceServerId ? { sourceServerId } : {}),
    controller,
  };
  ctx.connectFlights.set(options.profile.profileId, flight);
  return await promise;
}

export async function connectOnce(
  ctx: ManagerContext,
  options: ConnectSourceServerOptions,
  explicitDisconnectSignal?: AbortSignal,
): Promise<ManagedSourceServerConnection> {
  const { profile, target } = options;
  if (target.kind === "server" || profile.transport !== target.kind) {
    throw new Error(
      `Connection Profile ${profile.profileId} transport does not match target ${target.kind}`,
    );
  }
  const signal = options.context?.signal;
  let unpublishedConnection: ServerRemoteConnection | undefined;
  const throwIfAborted = () => {
    explicitDisconnectSignal?.throwIfAborted();
    signal?.throwIfAborted();
  };
  throwIfAborted();
  let commitMembership: ((sourceServerId: string) => Promise<void>) | undefined;
  if (ctx.options.admitConnection) {
    try {
      commitMembership = await ctx.options.admitConnection({
        profile,
        intent: options.membershipIntent ?? "retain",
        confirmIdentityChange: options.confirmIdentityChange === true,
      });
    } catch (error) {
      // 线路已移除时，迟到 admission 错误不再有权重建 failed 展示行。
      throwIfAborted();
      setState(ctx, profile.profileId, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
      throw error;
    }
  }
  throwIfAborted();
  if (profile.sourceServerId) {
    const existing = ctx.onlineBySourceServerId.get(profile.sourceServerId);
    if (existing) {
      await commitMembership?.(profile.sourceServerId);
      // 复用也经过异步成员提交；这段等待可能已被用户断开，不能返回旧 socket。
      throwIfAborted();
      if (ctx.onlineBySourceServerId.get(profile.sourceServerId) !== existing)
        throw new Error("Source Server connection changed during admission");
      existing.profileIds.add(profile.profileId);
      rememberSourceProfiles(ctx, profile.sourceServerId, existing.profileIds);
      setState(ctx, profile.profileId, {
        state: "online",
        sourceServerId: profile.sourceServerId,
      });
      return reusedConnection(ctx, existing);
    }
  }
  setState(ctx, profile.profileId, { state: "bootstrapping" });
  const adapter = getAdapter(ctx, profile.transport);
  let targetTransportCancelled = false;
  const cancelTargetTransport = () => {
    if (targetTransportCancelled) return;
    targetTransportCancelled = true;
    adapter.cancel?.(target);
  };
  if (signal?.aborted || explicitDisconnectSignal?.aborted) {
    cancelTargetTransport();
    throwIfAborted();
  }
  signal?.addEventListener("abort", cancelTargetTransport, { once: true });
  explicitDisconnectSignal?.addEventListener("abort", cancelTargetTransport, { once: true });
  let ignoreConnectionClose = false;
  try {
    options.onDiagnosticPhase?.("probe");
    const shouldRefreshDevelopmentArtifact =
      ctx.options.sourceServerArtifactPolicy === "development-content-addressed" &&
      target.kind === "ssh";
    const probe = await adapter.probe(
      target,
      options.context ?? {},
      shouldRefreshDevelopmentArtifact ? { includeReleaseIdentity: true } : undefined,
    );
    throwIfAborted();
    if (probe.installed) {
      const installedVersion = probe.installedVersion?.trim() || "unknown";
      let compatibleInstalledVersion = false;
      try {
        compatibleInstalledVersion =
          compareCompatibilityVersions(
            installedVersion,
            ctx.compatibilityManifest.minCompatibleVersion,
          ) >= 0;
      } catch {
        // Bug 原因：pre-R3 或损坏安装可能返回空值/unknown。继续执行新版本 ensureDaemon
        // 只会在 ingress-token 合同处变成通用 failed，用户也失去升级入口。
        compatibleInstalledVersion = false;
      }
      if (!compatibleInstalledVersion) {
        setState(ctx, profile.profileId, {
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: installedVersion,
          availableVersion: ctx.compatibilityManifest.productVersion,
          minimumVersion: ctx.compatibilityManifest.minCompatibleVersion,
          upgradeTarget: "server",
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          "server",
          installedVersion,
          ctx.compatibilityManifest.minCompatibleVersion,
        );
      }
      if (
        shouldRefreshDevelopmentArtifact &&
        installedVersion === ctx.compatibilityManifest.productVersion
      ) {
        const releaseResolver = options.resolveRelease ?? ctx.options.resolveRelease;
        if (!releaseResolver) {
          throw new Error("Development Source Server release is unavailable");
        }
        const release = await releaseResolver(probe, target);
        throwIfAborted();
        if (
          release.version === installedVersion &&
          release.sha256.toLowerCase() !== probe.installedArchiveSha256?.toLowerCase()
        ) {
          // Bug 原因（R3A-B-06）：开发态同版本刷新过去在这里直接 installOrUpdate，绕开了
          // updateServer 的 updating 状态、操作日志和 force 守卫确认；远端有运行中任务时 guard
          // 只能表现为普通连接失败，UI 既没有“强制更新”入口也不会在任务结束后重试。
          // 开发态与生产态只在“是否需要更新”的判定上不同（SHA vs 版本兼容），判定之后必须
          // 走同一条 needs-upgrade → updateSource/updateServer 链路，连接流程本身不执行更新。
          setState(ctx, profile.profileId, {
            state: "needs-upgrade",
            updateAvailability: "required",
            currentVersion: installedVersion,
            availableVersion: release.version,
            minimumVersion: ctx.compatibilityManifest.minCompatibleVersion,
            upgradeTarget: "server",
            errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerUpgradeRequiredError(
            profile.profileId,
            "server",
            installedVersion,
            ctx.compatibilityManifest.minCompatibleVersion,
            "development-archive",
          );
        }
      }
    }
    if (!probe.installed) {
      if (profile.sourceServerId) {
        await ctx.options.directory.markSourceUninstalled?.(profile.profileId);
        throwIfAborted();
      }
      const releaseResolver = options.resolveRelease ?? ctx.options.resolveRelease;
      const release =
        options.release ??
        (options.allowInstall && releaseResolver
          ? await releaseResolver(probe, target)
          : undefined);
      throwIfAborted();
      if (!release) {
        // 预览是附加信息；CDN/缓存元数据不可用时仍保留安装等待点。实际安装解析继续严格失败。
        const previewRelease = releaseResolver
          ? await releaseResolver(probe, target, { metadataOnly: true }).catch(() => undefined)
          : undefined;
        throwIfAborted();
        setState(ctx, profile.profileId, {
          ...(previewRelease
            ? {
                installPreview: {
                  version: previewRelease.version,
                  sizeBytes: previewRelease.sizeBytes,
                  ...(probe.installPath ? { installPath: probe.installPath } : {}),
                },
              }
            : {}),
          state: "needs-install",
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
          errorCode: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerInstallRequiredError(profile.profileId);
      }
      await adapter.installOrUpdate(target, release, options.context ?? {});
      throwIfAborted();
    }
    options.onDiagnosticPhase?.("daemon");
    const ingress = await adapter.ensureDaemon(target, options.context ?? {}, {
      observedStatus: probe.daemonStatus,
    });
    throwIfAborted();
    let published: { sourceServerId: string; connection: ServerRemoteConnection } | undefined;
    let closedBeforePublish: string | undefined;
    options.onDiagnosticPhase?.("protocol-handshake");
    const connectOptions: ServerRemoteDuplexConnectionOptions = {
      ingressToken: ingress.ingressToken,
      createConnection: async () =>
        await adapter.openChannel(target, ingress, options.context ?? {}),
      onClose: ({ reason }) => {
        if (ignoreConnectionClose) return;
        // Bug 原因（RV-P1-1）：close 事件过去只按 sourceServerId 路由，并用在线表是否存在做守卫。
        // 握手落盘（recordHandshake）期间连接关闭时，在线表要么为空（事件被丢弃，随后把已关闭的
        // 连接发布为 online），要么指向同一 Source 上另一条健康连接（sibling 的关闭会拆掉在线
        // owner 并清掉它的重试）。发布前只记录关闭事实，由发布点按连接失败收口；发布后才处理，
        // 且必须带上本连接身份，close 只作用于它所属的那条连接。
        if (!published) {
          closedBeforePublish = reason || "connection closed";
          return;
        }
        handleUnexpectedClose(ctx, published.sourceServerId, reason, published.connection);
      },
    };
    const connection = await ctx.connectServer(connectOptions);
    unpublishedConnection = connection;
    throwIfAborted();
    const compatibility = connection.serverInfo.compatibility;
    if (!compatibility) {
      setState(ctx, profile.profileId, {
        state: "needs-upgrade",
        updateAvailability: "required",
        currentVersion: connection.serverInfo.version,
        availableVersion: ctx.compatibilityManifest.productVersion,
        minimumVersion: ctx.compatibilityManifest.minCompatibleVersion,
        upgradeTarget: "server",
        errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
        retryable: false,
      });
      throw new SourceServerUpgradeRequiredError(
        profile.profileId,
        "server",
        connection.serverInfo.version,
        ctx.compatibilityManifest.minCompatibleVersion,
      );
    }
    const compatibilityResult = evaluateSourceServerCompatibility(
      ctx.compatibilityManifest,
      compatibility,
    );
    const compatibilityState = buildCompatibilityState(ctx.compatibilityManifest, compatibility);
    if (!compatibilityResult.compatible && compatibilityResult.upgradeTarget) {
      setState(ctx, profile.profileId, {
        state: "needs-upgrade",
        ...compatibilityState,
        errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
        retryable: false,
      });
      throw new SourceServerUpgradeRequiredError(
        profile.profileId,
        compatibilityResult.upgradeTarget,
        compatibilityResult.olderVersion,
        compatibilityResult.requiredMinimumVersion,
      );
    }
    const sourceServerId = connection.serverInfo.serverId;
    const connectedAt = ctx.now();
    options.onDiagnosticPhase?.("directory-record");
    const handshakeResult = await ctx.options.directory.recordHandshake(
      profile.profileId,
      {
        sourceServerId,
        osUser: connection.serverInfo.identity?.osUser,
        hostname: connection.serverInfo.identity?.hostname,
        version:
          connection.serverInfo.compatibility?.productVersion ?? connection.serverInfo.version,
        connectedAt,
        workspaces: connection.serverInfo.workspaces,
      },
      ...(options.confirmIdentityChange ? [{ confirmIdentityChange: true }] : []),
    );
    throwIfAborted();
    if (handshakeResult.identityChanged && options.confirmIdentityChange !== true) {
      setState(ctx, profile.profileId, {
        state: "identity-change-pending",
        sourceServerId: profile.sourceServerId,
        pendingSourceServerId: sourceServerId,
        errorCode: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
        retryable: false,
      });
      throw new SourceServerIdentityChangePendingError(profile.profileId, sourceServerId);
    }
    const effectiveProfile = handshakeResult.effectiveProfile ?? profile;
    // 关闭发生于目录落盘时不能再提交成员；健康 sibling owner 可继续承接本次 admission。
    if (closedBeforePublish !== undefined && !ctx.onlineBySourceServerId.has(sourceServerId))
      throw new SourceServerHandshakeClosedError(closedBeforePublish);
    await commitMembership?.(sourceServerId);
    throwIfAborted();
    options.onDiagnosticPhase?.("publish-online");
    if (effectiveProfile.profileId !== profile.profileId) {
      setState(ctx, profile.profileId, {
        state: "offline",
        ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
      });
    }

    const existing = ctx.onlineBySourceServerId.get(sourceServerId);
    if (existing) {
      existing.profileIds.add(effectiveProfile.profileId);
      rememberSourceProfiles(ctx, sourceServerId, existing.profileIds);
      setState(ctx, effectiveProfile.profileId, {
        state: "online",
        sourceServerId,
        ...compatibilityState,
      });
      return reusedConnection(ctx, existing);
    }
    if (closedBeforePublish !== undefined) {
      // 握手期间连接已死：不能发布，按普通连接失败抛出，让手动连接显示可重试失败、
      // 自动恢复路径继续下一档重试。放在 sibling join 之后：owner 健康时 join 才是正确结果。
      throw new SourceServerHandshakeClosedError(closedBeforePublish);
    }
    const managed: OnlineConnection = {
      sourceServerId,
      profileId: effectiveProfile.profileId,
      serverInfo: connection.serverInfo,
      services: connection.services,
      connection,
      profileIds: new Set([effectiveProfile.profileId]),
    };
    if (ctx.options.onProjectChange) {
      managed.projectSubscription = connection.services.broadcastService.onMessage((event) => {
        // 换代/断开后迟到广播不能代表当前 Source；通知仅触发读取，不带项目数据。
        if (
          event.channel === "state:projects" &&
          ctx.onlineBySourceServerId.get(sourceServerId) === managed
        )
          ctx.options.onProjectChange?.(sourceServerId);
      });
    }
    // Bug 原因：onDidReconnect 过去只挂在 retry/probe timer 回调和 updateServer 上；
    // retrying/offline 期间由 connect()（connectProfile / confirmIdentityChange）手动连接成功，
    // Manager 会清掉待触发的 retry timer 并发布 online，却不发 reconnect。Host wrapper 只在
    // reconnect 时换 services，Registry entry 的 recoveryReady 因此无人 resolve，同 route 新
    // connect 永久等待。reconnectInputs 只在首次发布时写入、显式断开时删除，「再次发布同一
    // Source」就是唯一的重连事实源：无论谁触发的连接，非在线 -> 在线都在这里统一 fire。
    const isRepublish = ctx.reconnectInputs.has(sourceServerId);
    ctx.onlineBySourceServerId.set(sourceServerId, managed);
    published = { sourceServerId, connection };
    unpublishedConnection = undefined;
    rememberSourceProfiles(ctx, sourceServerId, managed.profileIds);
    clearRecoveryTimers(ctx, sourceServerId);
    ctx.reconnectInputs.set(sourceServerId, {
      profile: effectiveProfile,
      target,
      // 操作级 onLog 捕获本次日志及凭据；恢复不得持有旧闭包，下一次操作会重新建日志上下文。
      context: {},
    });
    setState(ctx, effectiveProfile.profileId, {
      state: "online",
      sourceServerId,
      ...compatibilityState,
    });
    if (isRepublish) ctx.reconnectEmitter.fire(managed);
    return managed;
  } catch (error) {
    if (
      error instanceof SourceServerUpgradeRequiredError &&
      !signal?.aborted &&
      !explicitDisconnectSignal?.aborted
    ) {
      await options.onAuthenticatedUpgradeRequired?.();
    }
    if (explicitDisconnectSignal?.aborted) {
      throw explicitDisconnectSignal.reason;
    }
    if (
      error instanceof SourceServerInstallRequiredError ||
      error instanceof SourceServerUpgradeRequiredError ||
      error instanceof SourceServerIdentityChangePendingError
    )
      throw error;
    const normalized = normalizeRemoteConnectionError(error);
    const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
    const retryable =
      error && typeof error === "object" && "retryable" in error
        ? (error as { retryable?: unknown }).retryable
        : undefined;
    setState(ctx, profile.profileId, {
      state: "failed",
      error: normalized.message,
      ...(errorCode ? { errorCode } : {}),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
    });
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelTargetTransport);
    explicitDisconnectSignal?.removeEventListener("abort", cancelTargetTransport);
    // Bug 原因：分支内释放遗漏了握手落盘拒绝和兼容版本解析异常，恢复重试会累积连接。
    // 握手、目录写入、身份确认、成员提交共用这一个未发布资源出口；在线表接管前始终由本次
    // 尝试持有连接，统一释放并忽略其关闭事件，避免影响后继 owner。
    if (unpublishedConnection) {
      ignoreConnectionClose = true;
      unpublishedConnection.dispose();
    }
  }
}
