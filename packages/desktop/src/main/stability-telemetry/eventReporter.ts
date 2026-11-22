import armsRum from "@arms/rum-electron";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import { STABILITY_TELEMETRY_SCHEMA_VERSION } from "./constants.js";
import type { StabilityLifecycleScene, StabilityLogger, StabilityWindowScene } from "./types.js";

export interface StabilityGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: StabilityGlobalContext | null = null;
let lifecycleScene: StabilityLifecycleScene = "runtime";

export function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

export function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function resolveStabilityMetricValue(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
): number {
  switch (name) {
    case "perf_anr":
    case "perf_freeze": {
      const duration = Number(properties.duration_ms);
      return Number.isFinite(duration) ? duration : 0;
    }
    case "perf_app_exit":
    case "perf_process_exit": {
      const exitCode = Number(properties.exit_code);
      return Number.isFinite(exitCode) ? exitCode : 0;
    }
    case "perf_crash":
      return 1;
    case "perf_app_start":
    default:
      return 1;
  }
}

export function getStabilityGlobalContext(): StabilityGlobalContext | null {
  return globalContext;
}

export function reportStabilityCustom(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
  windowScene?: StabilityWindowScene,
  lifecycleSceneOverride?: StabilityLifecycleScene,
): void {
  if (!globalContext) {
    return;
  }

  const metricValue = resolveStabilityMetricValue(name, properties);

  const payload = stringifyProperties({
    event_name: name,
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    telemetry_schema_version: STABILITY_TELEMETRY_SCHEMA_VERSION,
    scene_lifecycle: lifecycleSceneOverride ?? lifecycleScene,
    scene_window: windowScene ?? "main",
    metric_value: metricValue,
    ...properties,
  });

  try {
    // ARMS 原始日志/控制台按 custom 类型展示；业务分组用 group
    // value 填具体数值：ANR/挂死为 duration_ms，退出为 exit_code，计数类统一为 1
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "stability",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    // 稳定性上报失败不应影响主流程
    console.warn("[stability] sendCustom failed:", name, error);
  }
}

export function configureDesktopStabilityTelemetry(context: StabilityGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

export function notifyStabilityLifecycle(scene: StabilityLifecycleScene): void {
  lifecycleScene = scene;
}

export function getStabilityLifecycleScene(): StabilityLifecycleScene {
  return lifecycleScene;
}

export function notifyStabilityAppExit(
  scene: StabilityLifecycleScene,
  logger: StabilityLogger,
  options?: { exitCode?: number; exitKind?: string },
): void {
  // Bug 根因：旧实现上报 perf_app_exit 后立即恢复 runtime；Agent/Host 的异步退出事件
  // 因而丢失 app_quit/update_install 边界并被误计为 crash。退出流程一旦开始就不可逆，
  // lifecycle 必须保持到主进程终止。
  lifecycleScene = scene;
  reportStabilityCustom("perf_app_exit", {
    exit_code: options?.exitCode ?? 0,
    exit_kind: options?.exitKind ?? "normal",
  });
  logger.info("[stability] perf_app_exit reported", { scene, exitCode: options?.exitCode ?? 0 });
}
