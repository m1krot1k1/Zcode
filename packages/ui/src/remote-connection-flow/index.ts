import { useRemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";
import { useRemoteConnectionDialogLifecycle } from "@/remote-connection-flow/useRemoteConnectionDialogLifecycle.js";
import { useRemoteConnectionConnect } from "@/remote-connection-flow/useRemoteConnectionConnect.js";
import { useRemoteConnectionActions } from "@/remote-connection-flow/useRemoteConnectionActions.js";
import { useRemoteConnectionIntent } from "@/remote-connection-flow/useRemoteConnectionIntent.js";
import { buildRemoteConnectionView } from "@/remote-connection-flow/buildRemoteConnectionView.js";

import type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";
export type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";

/**
 * 远程连接 flow 的对外入口。实现按 owner 分文件：状态、弹窗收尾、连接编排、
 * 表单动作、入口意图与只读视图投影；子 hook 的调用顺序与原单体 hook 完全一致。
 */
export function useRemoteConnectionFlow(options: RemoteConnectionFlowOptions) {
  const core = useRemoteConnectionFlowState(options);
  const dialog = useRemoteConnectionDialogLifecycle(core);
  const connect = useRemoteConnectionConnect(core, dialog);
  const actions = useRemoteConnectionActions(core, dialog, connect);
  const intent = useRemoteConnectionIntent(core, dialog, actions);
  return buildRemoteConnectionView({ core, dialog, connect, actions, intent });
}
