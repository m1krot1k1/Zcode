import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
  type ZCodeProtocolRequest,
} from "@zcode/shared";
import { parseParams, ProtocolRequestError } from "./server-types.js";

/**
 * 两类可取消长操作的 controller 注册表：插件操作（plugins/*）与
 * workspace/generateText 各一张表，按 Host 下发的 operationId 精确命中。
 */
export interface PluginOperationRegistries {
  readonly pluginOperations: Map<string, AbortController>;
  readonly workspaceGenerateText: Map<string, AbortController>;
}

export function createPluginOperationRegistries(): PluginOperationRegistries {
  return {
    pluginOperations: new Map<string, AbortController>(),
    workspaceGenerateText: new Map<string, AbortController>(),
  };
}

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

export async function withPluginOperationSignal<T>(
  registries: PluginOperationRegistries,
  request: ZCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getOperationId(request.params);
  if (!operationId) return await run();

  const controller = new AbortController();
  registries.pluginOperations.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (registries.pluginOperations.get(operationId) === controller) {
      registries.pluginOperations.delete(operationId);
    }
  }
}

export function cancelPluginOperation(
  registries: PluginOperationRegistries,
  rawParams: unknown,
): { operationId: string; cancelled: boolean } {
  const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
  const controller = registries.pluginOperations.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
  controller.abort();
  registries.pluginOperations.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}

export async function withWorkspaceGenerateTextSignal<T>(
  registries: PluginOperationRegistries,
  request: ZCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getOperationId(request.params);
  if (!operationId) return await run();

  if (registries.workspaceGenerateText.has(operationId)) {
    // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
    // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
    throw new ProtocolRequestError(
      -32600,
      `Workspace generate operation is already active: ${operationId}`,
    );
  }

  const controller = new AbortController();
  registries.workspaceGenerateText.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (registries.workspaceGenerateText.get(operationId) === controller) {
      registries.workspaceGenerateText.delete(operationId);
    }
  }
}

export function cancelWorkspaceGenerateText(
  registries: PluginOperationRegistries,
  rawParams: unknown,
): { operationId: string; cancelled: boolean } {
  const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
  const controller = registries.workspaceGenerateText.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
  registries.workspaceGenerateText.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}

/** 连接关闭/进程退出：所有未完成的长操作都要按同一错误终止并清空注册表。 */
export function abortPluginOperations(
  registries: PluginOperationRegistries,
  error: Error,
): void {
  for (const controller of registries.workspaceGenerateText.values()) {
    controller.abort(error);
  }
  registries.workspaceGenerateText.clear();
  for (const controller of registries.pluginOperations.values()) {
    controller.abort(error);
  }
  registries.pluginOperations.clear();
}

/** shutdown 在 disconnect 之后仍逐表 abort：幂等，且不依赖 disconnect 的调用顺序。 */
export function abortRemainingOperations(
  registries: PluginOperationRegistries,
  error: Error,
): void {
  for (const controller of registries.pluginOperations.values()) controller.abort(error);
  for (const controller of registries.workspaceGenerateText.values()) controller.abort(error);
}
