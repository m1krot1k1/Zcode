import type { SourceServerFileTransfer } from "@zcode/server/source-server";
import { getAdapter } from "./adapters.js";
import type { ManagedSourceServerConnection, ManagerContext } from "./types.js";

export function getOnlineConnection(
  ctx: ManagerContext,
  sourceServerId: string,
): ManagedSourceServerConnection | undefined {
  return ctx.onlineBySourceServerId.get(sourceServerId);
}

export function getFileTransfer(
  ctx: ManagerContext,
  sourceServerId: string,
): SourceServerFileTransfer {
  const online = ctx.onlineBySourceServerId.get(sourceServerId);
  const input = ctx.reconnectInputs.get(sourceServerId);
  if (!online || !input) throw new Error("Source Server file transfer is unavailable");
  const backend = getAdapter(ctx, input.profile.transport).createFileTransfer(input.target);
  const assertCurrent = () => {
    // 暂存属于当前 attachment generation；旧能力不能在重连后悄悄使用新线路或重建连接。
    if (ctx.onlineBySourceServerId.get(sourceServerId) !== online) {
      throw new Error("Source Server file transfer generation is unavailable");
    }
  };
  return {
    exec: async (command) => {
      assertCurrent();
      return backend.exec(command);
    },
    upload: async (localPath, remotePath, options) => {
      assertCurrent();
      await backend.upload(localPath, remotePath, options);
      assertCurrent();
    },
  };
}
