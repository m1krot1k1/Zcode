/**
 * 插件 Hook 的解析与 inspection 投影。
 *
 * 从 plugins/index.ts 拆出以满足 max-lines：本文件只做无状态的纯变换（校验、matcher 归一、
 * detail 投影、合并），不读取信任存储、不决定 runnable，也不创建外部进程。信任判定在
 * plugin-hook-trust.ts，调用方负责在两者之间传递结果。
 */
import type {
  HookConfig,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginDiagnostic,
  PluginHookDetail,
} from "@zcode/contracts";
import type { LoadedPlugin } from "./types.js";
import { HookEventName as HookEventNameValue, HookMatcherConfigSchema } from "@zcode/contracts";
import { isRecord } from "./helpers.js";
import { listPluginHookSources } from "./hook-sources.js";

export const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

export interface PluginHookInspection {
  details: PluginHookDetail[];
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export function inspectPluginHooks(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  runnable: boolean;
}): PluginHookInspection {
  const inspection = emptyHookInspection();
  for (const source of listPluginHookSources({
    diagnostics: input.diagnostics,
    loaded: input.loaded,
  })) {
    const loaded = parsePluginHookEvents({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      pluginDataPath: input.dataPath,
      rawHooks: source.rawHooks,
      runnable: input.runnable,
      sourcePath: source.sourcePath,
      wrapper: source.wrapper,
    });
    mergeHookInspection(inspection, loaded);
  }

  return inspection;
}

function parsePluginHookEvents(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  pluginDataPath: string;
  rawHooks: unknown;
  runnable: boolean;
  sourcePath: string;
  wrapper: boolean;
}): PluginHookInspection {
  const hooksRoot = input.wrapper
    ? isRecord(input.rawHooks)
      ? input.rawHooks.hooks
      : undefined
    : input.rawHooks;
  const inspection = emptyHookInspection();
  if (!isRecord(hooksRoot)) {
    input.diagnostics.push({
      code: "plugin_hook_invalid",
      message: input.wrapper
        ? "Plugin hooks file must contain a hooks object"
        : "Plugin manifest hooks entry must be an object, a path, or an array",
      path: input.sourcePath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return inspection;
  }

  const plugin = createHookPluginContext(input.loaded, input.pluginDataPath, input.sourcePath);
  for (const [eventName, matcherConfigs] of Object.entries(hooksRoot)) {
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
      input.diagnostics.push({
        code: "plugin_hook_unsupported_event",
        message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    if (!Array.isArray(matcherConfigs)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: `Plugin hook event must be an array: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const event = eventName as HookEventName;
    for (const matcherConfig of matcherConfigs) {
      const validation = HookMatcherConfigSchema.safeParse(matcherConfig);
      if (!validation.success) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Invalid plugin hook matcher for ${eventName}: ${validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          path: input.sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      const withPlugin: HookMatcherConfig = {
        ...validation.data,
        hooks: validation.data.hooks.map((hook) => attachPluginToHook(hook, plugin)),
      };
      (inspection.events[event] ??= []).push(withPlugin);
      for (const hook of validation.data.hooks) {
        inspection.details.push(
          toPluginHookDetail({
            event,
            hook,
            ...(validation.data.matcher !== undefined ? { matcher: validation.data.matcher } : {}),
            runnable: input.runnable,
            sourcePath: input.sourcePath,
          }),
        );
      }
    }
  }

  return inspection;
}

function toPluginHookDetail(input: {
  event: HookEventName;
  hook: HookConfig;
  matcher?: string;
  runnable: boolean;
  sourcePath: string;
}): PluginHookDetail {
  const detail: PluginHookDetail = {
    command: input.hook.command,
    event: input.event,
    runnable: input.runnable,
    sourcePath: input.sourcePath,
    type: input.hook.type,
  };
  if (input.matcher !== undefined) detail.matcher = input.matcher;
  if (input.hook.statusMessage !== undefined) detail.statusMessage = input.hook.statusMessage;
  if (input.hook.timeoutMs !== undefined) detail.timeoutMs = input.hook.timeoutMs;
  if (input.hook.type === "process") {
    if (input.hook.args !== undefined) detail.args = input.hook.args;
    return detail;
  }
  if (input.hook.async !== undefined) detail.async = input.hook.async;
  if (input.hook.shell !== undefined) detail.shell = input.hook.shell;
  if (input.hook.timeout !== undefined) detail.timeout = input.hook.timeout;
  return detail;
}

export function createHookPluginContext(
  loaded: LoadedPlugin,
  dataPath: string,
  sourcePath?: string,
): HookPluginContext {
  return {
    dataPath,
    id: loaded.id,
    name: loaded.manifest.name,
    rootPath: loaded.rootPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function attachPluginToHook(hook: HookConfig, plugin: HookPluginContext): HookConfig {
  return {
    ...hook,
    plugin,
  };
}

export function mergeHookEvents(
  target: Partial<Record<HookEventName, HookMatcherConfig[]>>,
  source: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): void {
  for (const [eventName, matchers] of Object.entries(source) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length > 0) {
      (target[eventName] ??= []).push(...matchers);
    }
  }
}

function mergeHookInspection(target: PluginHookInspection, source: PluginHookInspection): void {
  mergeHookEvents(target.events, source.events);
  target.details.push(...source.details);
}

export function emptyHookInspection(): PluginHookInspection {
  return {
    details: [],
    events: {},
  };
}
