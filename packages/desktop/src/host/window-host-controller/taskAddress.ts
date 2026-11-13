import type { WindowHostAttachmentScope } from "@zcode/shared";
import type { WindowHostTaskAddress } from "@zcode/shared/zcode-protocol-v4";
import type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerRuntimeContext,
} from "./types.js";

export interface ResolveTaskAddressParams {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  attachmentScope?: WindowHostAttachmentScope;
  allowMissingTask?: boolean;
}

/**
 * 解析列表 mutation 的唯一 source 地址。remote attachment 必须与 source 的
 * remoteSessionId + identity 完整匹配；首次绑定 workspace 时先物化已验证的 source。
 */
export function createWindowHostControllerTaskAddressResolver(
  context: WindowHostControllerRuntimeContext,
): (params: ResolveTaskAddressParams) => Promise<WindowHostTaskAddress> {
  const { options, projection, refreshSource, state } = context;
  const { resolveCurrentSource } = state;

  return async function resolveTaskAddress(params) {
    const remoteAttachmentScope =
      params.attachmentScope?.kind === "remote" ? params.attachmentScope : undefined;
    if (remoteAttachmentScope) {
      if (
        remoteAttachmentScope.workspacePath !== params.workspacePath ||
        remoteAttachmentScope.workspaceIdentity !== params.workspaceIdentity
      ) {
        throw new Error("列表 mutation 与 remote attachment scope 不匹配");
      }
    }
    const resolved = options.resolveSource({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const assertAttachmentSource = (source: ResolvedWindowHostControllerSource | null) => {
      if (
        remoteAttachmentScope &&
        (!source ||
          source.scope.kind !== "remote" ||
          source.scope.remoteSessionId !== remoteAttachmentScope.remoteSessionId ||
          source.scope.workspacePath !== remoteAttachmentScope.workspacePath ||
          source.scope.workspaceIdentity !== remoteAttachmentScope.workspaceIdentity)
      ) {
        throw new Error("列表 mutation 与 remote attachment source 不匹配");
      }
    };
    assertAttachmentSource(resolved);
    if (resolved) {
      // remote attachment 曾直接返回 address，跳过 source refresh；新绑定的
      // workspace 尚未读取 Controller 列表时没有投影行，导致 unread/archive 等首次写入失败。
      // 这里只物化已按完整 remoteSessionId + identity 验证的 source，继续保持 fail-closed。
      await refreshSource(resolved);
      assertAttachmentSource(resolveCurrentSource(resolved.scope));
    }
    // 侧栏可先按稳定 Source 查询，之后才创建 attachment；投影行没有新 sessionId
    // 不代表任务缺失。先验证当前 attachment，再按同一 Source 匹配，旧地址路径仍精确匹配。
    const sourceServerId =
      resolved?.scope.kind === "remote" ? resolved.scope.sourceServerId : undefined;
    const matches = projection
      .getTasks()
      .filter(
        (row) =>
          row.address.taskId === params.taskId &&
          row.address.workspacePath === params.workspacePath &&
          row.address.workspaceIdentity === params.workspaceIdentity &&
          (!remoteAttachmentScope ||
            (sourceServerId
              ? row.address.sourceServerId === sourceServerId
              : row.address.remoteSessionId === remoteAttachmentScope.remoteSessionId)),
      );
    if (matches.length !== 1) {
      if (matches.length === 0 && params.allowMissingTask && resolved) {
        // 条件删除允许已被其它客户端删除的目标到 Repo 幂等跳过；source 身份仍须完整验证。
        return {
          taskId: params.taskId,
          workspacePath: resolved.scope.workspacePath,
          ...(resolved.scope.workspaceIdentity
            ? { workspaceIdentity: resolved.scope.workspaceIdentity }
            : {}),
          ...(resolved.scope.kind === "remote"
            ? { remoteSessionId: resolved.scope.remoteSessionId }
            : {}),
        };
      }
      throw new Error(
        `列表 mutation 无法解析唯一 source，taskId=${params.taskId}, matches=${matches.length}`,
      );
    }
    return matches[0]!.address;
  };
}
