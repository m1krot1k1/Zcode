// CUA-сервисы Host: жизненный цикл product Helper, PiP-сессии, permission API
// и динамический MCP-resolver для built-in plugin.
import type { BuildContext, CoreServices } from "./bundles.js";
import {
  CuaHelperLifecycleManager,
  ICuaPermissionService,
  createCuaPipSessionService,
  isOfficialCuaPluginEnabledForWorkspace,
  resolveStandaloneStatusLaunchAppPath,
} from "#src/cua-permission-broker/index.js";
import {
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionState,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
  type CuaProductMcpServerResolverContext,
} from "#src/cua-permission-broker/index.js";
import { getStableCuaPipeName } from "#src/cua-permission-broker/stableCuaTransport.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createCanonicalCuaHelperInstaller } from "../cua-permission-broker/cuaHelperInstaller.js";
import {
  createDefaultCuaProductHelper,
  createDynamicCuaProductMcpServerResolver,
  resolveBundledCuaHelperAppPath,
  resolveCuaScreenRecordingState,
  runCuaScreenCaptureReadinessProbe,
  shouldCreateDefaultCuaProductHelper,
  shouldRetainDefaultCuaProductHelper,
  shouldUseCuaPermissionService,
} from "./cua-helpers.js";
import {
  type DefaultCuaProductHelper,
  type ManagedDefaultCuaProductHelper,
} from "./cua-helpers.js";
import { isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { buildHelperOpenArgs, isCuaLocalDevelopmentRuntime } from "@zcode/zcode-cua/broker/server";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";

export function createCuaServices(args: BuildContext & CoreServices) {
  const { options } = args;
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // 保留 main 原有 gate 行为（避免回归）：dev/internal 特性开启时（ZCODE_CUA_DEV_MODE=1 或
    // ZCODE_CUA_PRODUCT_HELPER=1）即视为启用，不依赖 config.json 显式 enable——main 的 bootstrap
    // 用 isZCodeCuaInternalFeatureEnabled 门控 bundled plugin，与 feat 的 workspace enablement 不同。
    // 生产路径（dev mode off）回落到官方插件 workspace enablement 判定（与 feat 一致）。
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // 转发活跃-turn 查询（前向引用，zcodeAgentService 建好后赋值）。
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // 历史默认装配启动 10 秒周期 watchdog；空闲期一次 broker_info 超时就会在后台
    // 调用 resolver.restart()。Helper 不是 Agent runtime owner，且无需在没有 CUA 需求时自愈；
    // 健康检查保留在 spawn env / resolver request boundary，避免后台 timer 干扰其他模块。
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Helper 懒启动：宿主启动时仅探测稳定 socket 上是否有一个
  // 自启动（SDK 首调拉起）的 Helper。只 ping，绝不拉起；300ms 预算。probe 结果仅用于
  // 状态展示 / PiP 凭据发现；权限详情与 onboarding 仍走显式 host 流。
  const probeStableCuaHelperSocket = async (): Promise<string | null> => {
    const socketPath =
      process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
    try {
      const { createConnection } = await import("node:net");
      return await new Promise<string | null>((resolve) => {
        const socket = createConnection(socketPath);
        const finish = (value: string | null): void => {
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 300);
        socket.on("connect", () => {
          clearTimeout(timer);
          socket.write(`{"id":0,"method":"ping","params":{}}\n`);
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n")) {
              try {
                const nl = buffer.indexOf("\n");
                const reply = JSON.parse(buffer.slice(0, nl)) as {
                  ok?: boolean;
                };
                finish(reply.ok === true ? socketPath : null);
              } catch {
                finish(null);
              }
            }
          });
        });
        socket.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
      });
    } catch {
      return null;
    }
  };

  // 按需启动：拉起 standalone Helper（稳定 socket）。dev 场景（本 Helper 构建内嵌 dev
  // policy）成对带 unsigned-launcher/external-escape argv，让 ad-hoc 签名的本进程也能过
  // 签名门查询；产品 Helper 不嵌 dev policy，这对 argv 无效（产品签名天然过 Team 门）。
  // 拉起后轮询 ping（5s/100ms），就绪返回 socket 路径，否则 null。
  //
  // dev 判定直接用上游的 isCuaLocalDevelopmentRuntime（@zcode/zcode-cua/broker/server，
  // 即本文件已经用来 import buildHelperOpenArgs 的那个 subpath，可正常导入）。
  //
  // 行为等价性（别误读成安全加固）：上游是 `COMPILED_LOCAL_DEVELOPMENT_RUNTIME &&
  // ZCODE_RUNTIME_ENV!=="production"`，而那个编译期常量只有 scripts/build-cua-helper-app.mjs
  // 会用 define 折叠（Helper bundle）；desktop host bundle 没有该 define，于是回退成
  // `process.env.NODE_ENV !== "production"` —— 正是复制品写的那一项。所以在**当前**打包形态下
  // 两者逐字等价，关门靠的是 ZCODE_RUNTIME_ENV=production（打包态显式注入且不传 NODE_ENV）。
  //
  // 换成上游的收益是消除漂移面：折叠点、因子个数与 fail-closed 方向都由上游一处决定，
  // 哪天 host bundle 也补上 __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ define（Helper 侧已经有），
  // 编译期门自动生效，不需要再回来改这里。

  const cuaStatusLaunchLog = createServiceLogger("cua-status-launch");
  const launchStandaloneCuaHelperForStatus = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return null;
    const { existsSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const socketPath = resolveBrokerSocketPath();
    let appPath: string | null;
    try {
      appPath = await resolveStandaloneStatusLaunchAppPath({
        env: process.env,
        bundledAppPath: resolveBundledCuaHelperAppPath(),
        exists: existsSync,
        ensureInstalled: (bundledAppPath) =>
          createCanonicalCuaHelperInstaller({
            logger: cuaStatusLaunchLog,
            env: process.env,
            bundledAppPath,
          }).ensureInstalled(),
      });
    } catch (error) {
      cuaStatusLaunchLog.warn(undefined, "CUA Helper install before status launch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!appPath) return null;
    // Helper 启动参数统一由 buildHelperOpenArgs 构造，避免多处手写导致漏传或漂移。
    // 设置页只读权限探测不承载 PiP，不传 --launcher-pid 和 --pip-mode；
    // exit-log 使用 .settings.exit.log。新增参数应定义在 HelperLaunchSpec 中供调用方共用。
    const args = buildHelperOpenArgs({
      appPath,
      socketPath,
      exitLogPath: `${socketPath}.settings.exit.log`,
      ...(isCuaLocalDevelopmentRuntime(process.env)
        ? {
            allowUnsignedLauncherLocalDev: true,
            allowExternalBrokerClientLocalDev: true,
          }
        : {}),
    });
    try {
      await promisify(execFile)("/usr/bin/open", args, { timeout: 5_000 });
    } catch {
      // LaunchServices 已接单也可能超时；继续等 ping。
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  const launchWindowsCuaHelperForStatus = async (): Promise<string | null> => {
    try {
      const managed = await getOrCreateDefaultCuaProductHelper(undefined);
      if (managed) void managed.host.start().catch(() => {});
    } catch {}
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // enabled 与 onCuaPipSessionLifecycle 是否挂上，都由 serviceAuthorityMode 单点决定；
  // 提出来命名，避免下面的启动期诊断与真实取值漂移。
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const host = defaultCuaProductHelperLifecycle.peek()?.helper.macPermissionHost;
      // PiP 客户端以 role=presentation 声明，资格由 Helper 按对端（ZCode 主进程）签名 identifier 裁决。
      if (host?.running && host.socketPath) {
        return {
          socketPath: host.socketPath,
        };
      }
      // 懒启动：无托管 host 时探测稳定 socket 上自启动的 Helper（probe-only，不拉起）。
      const stable = await probeStableCuaHelperSocket();
      return stable ? { socketPath: stable } : undefined;
    },
  });
  // 启动期就把 PiP 投递链的接线状态写出来。dev 实测 PiP 事件一条都没投，而
  // 「enabled=false」与「lifecycle 回调没挂（tracker 整体 undefined、accept 全程 no-op）」
  // 这两种成因在运行期都不产生任何日志，只能靠这行在启动时分辨——重启即可判定，
  // 不必先跑一轮 CUA。scope 沿用 cua-pip-session：已验证该 logger 的 info 会进宿主日志。
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // Computer Use Helper macOS 权限状态服务：renderer 经 host RPC 查询当前 Helper 的运行态与权限，并在
  // 用户授权后从明确入口精确重启一次 Helper。重启**必须走 resolver.restart()**（不是裸 host.restart），
  // 因为 resolver 优先复用既有 socket/token；裸 host.restart() 可能 fresh 新凭据，使已有 Agent
  // 继续持有旧 transport，无法连接新的 broker。
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 插件关闭只门控后续 Agent；权限页刷新不得进入 acquire，否则会把仍被已有 Agent 使用的 Helper 停掉。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 懒启动：状态查询绝不拉起 Helper。托管 host 在（如刚完成授权流）→ 全量查询；
      // 否则探测稳定 socket 上自启动的 Helper（probe-only）；都没有 → 未运行（首次使用时自动启动）。
      const peeked = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = peeked && isDefaultCuaProductHelperCurrent(peeked) ? peeked : undefined;
      const host = helper ? helper.macPermissionHost : undefined;
      if (!host || !host.running) {
        // Helper 按需启动：设置页查询 = 拉起 standalone Helper（稳定 socket、
        // 无 launcher-pid → 300s 无访问自动休眠，不进托管体系）。拉起后经稳定 socket 查真值。
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable =
            process.platform === "darwin"
              ? await launchStandaloneCuaHelperForStatus()
              : await launchWindowsCuaHelperForStatus();
        }
        if (!stable) {
          return {
            available: false,
            reason:
              "ZCode Computer Use is not running; it will start automatically on first Computer Use use.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
        // standalone Helper 上直接查权限真值（身份模式，无 token）。
        try {
          const { callBrokerMethod } = await import("@zcode/zcode-cua/broker/helperHealth");
          const report = await callBrokerMethod<{
            grant_owner: string;
            owner?: { display_name?: string };
            accessibility: CuaPermissionState;
            accessibility_probe_ok?: boolean;
            screen_recording: CuaPermissionState;
          }>({
            socketPath: stable,
            method: "permission_status",
            timeoutMs: 3000,
          });
          return {
            grantOwner: report.grant_owner,
            grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
            accessibility: report.accessibility,
            accessibilityProbeOk: report.accessibility_probe_ok === true,
            screenRecording: report.screen_recording,
            screenCaptureProbeOk: false,
          };
        } catch {
          return {
            available: false,
            reason: "ZCode Computer Use is starting up; retry in a moment.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
      }
      try {
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Screen Recording 的真值必须来自一个新进程：撤销对已运行的常驻 Helper 不生效，
        // 它会一直报撤销前的 granted。拿不到真值时 fail-open 沿用 report 值。
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // 真实 screen-capture 探针：TCC screen_recording === "granted" 只说明系统记录了授权，并不保证
        // WindowServer 已对本进程放行像素（wallpaper-frame / SR-not-live 背离）。只有真的抓到非空像素
        // 才算 screen 端到端可用——UI 的"就绪/自动关闭"据此判定。fail-closed：探测抛错/超时一律 false。
        // 用预检后的 state 做门控：预检已判 denied 时没有必要再花一次抓屏。
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            report.accessibility_probe?.ok === true &&
            report.accessibility_probe?.classification === "functional",
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      // macOS перезапускает Helper-процесс (TCC привязан к процессу). Windows/Linux
      // Helper-процесса в этом смысле не имеют: Linux-хост перепроверяет окружение
      // через probe(refresh) при следующем действии, поэтому «перезапуск» здесь —
      // честный no-op с явным статусом, а не имитация.
      if (process.platform !== "darwin") {
        return {
          ok: process.platform === "win32" || process.platform === "linux",
          reason:
            process.platform === "linux"
              ? "Linux CUA host не имеет Helper-процесса: проверка окружения выполняется при следующем действии."
              : "CUA Helper restart is only required on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 与 getStatus 一致：插件关闭时不触碰现有 Helper，避免设置页动作改变已有 Agent runtime。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 走 resolver.restart()，让 host 尽可能复用 transport；不得通过 disposeWorkspace
      // 重建正在运行的 Agent。
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart ZCode Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };

  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // 动态 resolver：isPluginEnabled 与 helper 创建用同一个 isCuaEnabledForContext 门控（dev mode 一致），
  // 避免开发场景下 resolver pass-through 而 helper 已建的割裂。
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only——resolver 属托管 host 体系，host 未建时返回 undefined（懒启动下
      // CUA 经 node_repl + 稳定 socket，不依赖此 resolver）；绝不在此 acquire。
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const setActiveTurnGetter = (getter: () => boolean): void => {
    hasActiveTurnRef = getter;
  };

  return {
    cuaPermissionService,
    cuaPipSessionService,
    cuaProductMcpServerResolver,
    cuaProductHelperLifecycle: defaultCuaProductHelperLifecycle,
    setActiveTurnGetter,
    isCuaEnabledForContext,
  };
}
