import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  DeviceAdditionResult,
  DeviceAdditionReturnTarget,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { logger } from "@/logger.js";

/** 仅当前 renderer 内存中的返回目标；不持久化草稿或凭据。 */
export interface DeviceAdditionReturnState {
  target: DeviceAdditionReturnTarget;
  completion?: "checking" | "delivered";
  tabId: string | null;
  workspaceKey?: string;
}

export type DeviceAdditionReturnRef = MutableRefObject<DeviceAdditionReturnState | null>;

type TabStoreApi = ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;

/**
 * 设备新增/重连的返回目标 owner。
 *
 * `deviceAdditionReturn` 与 `finishDeviceAddition` 必须共用同一个 ref：异步资格校验用引用相等
 * 判断结果是否仍属于当前入口，新入口会先替换 ref，迟到结果随即失效。
 */
export function useRootDeviceAdditionReturn({
  tabStoreApi,
  remoteConnectionInProgress,
  setRemoteConnectionDialogOpen,
  setRemoteConnectionOpenPreference,
  setRemoteConnectionOpenIntentId,
}: {
  tabStoreApi: TabStoreApi;
  remoteConnectionInProgress: boolean;
  setRemoteConnectionDialogOpen: Dispatch<SetStateAction<boolean>>;
  setRemoteConnectionOpenPreference: Dispatch<
    SetStateAction<RemoteConnectionOpenPreference | null>
  >;
  setRemoteConnectionOpenIntentId: Dispatch<SetStateAction<number>>;
}) {
  const deviceAdditionReturn = useRef<DeviceAdditionReturnState | null>(null);
  const finishDeviceAddition = useCallback(
    async (
      result: DeviceAdditionResult,
      background = false,
      canDeliver: () => boolean = () => true,
    ) => {
      const pending = deviceAdditionReturn.current;
      // 同步消费；异步资格校验仍保留同一 owner 标识，新入口替换后旧结果无权导航。
      if (!pending) return false;
      if (pending.completion && result.kind === "connected") return true;
      pending.completion = "checking";
      const isCurrent = () =>
        deviceAdditionReturn.current === pending && pending.target.isCurrent();
      const deliver = (value: DeviceAdditionResult, inBackground: boolean) => {
        if (!isCurrent()) return;
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === pending.tabId);
        const workspaceKey =
          tab?.kind === "workspace"
            ? tab.workspaceIdentity?.trim() || tab.workspacePath
            : undefined;
        if ((pending.tabId && !tab) || pending.workspaceKey !== workspaceKey) return;
        if (pending.tabId && !inBackground) tabs.activateTab(pending.tabId);
        logger.debug("[Root] return from device addition", {
          kind: value.kind,
          tabId: pending.tabId,
        });
        pending.completion = "delivered";
        return pending.target.finish(value);
      };
      try {
        if (result.kind === "connected" && pending.target.canFinish) {
          const valid = await pending.target.canFinish(result);
          if (!isCurrent()) return true;
          if (!valid) {
            await deliver({ kind: "cancelled", background: true }, true);
            return true;
          }
        }
        if (result.kind === "connected" && !canDeliver()) {
          pending.completion = undefined;
          return true;
        }
        const finished = deliver(result, background);
        // 显式取消必须撤销在途校验；迟到成功不能再使用同一返回引用恢复旧聊天。
        if (result.kind === "cancelled" && deviceAdditionReturn.current === pending)
          deviceAdditionReturn.current = null;
        await finished;
      } catch (error) {
        if (!isCurrent()) return true;
        // 读取失败不是取消。保留原 owner 和禁发约束，让连接 flow 显示原因并提供重试/取消。
        pending.completion = undefined;
        throw error;
      }
      return true;
    },
    [tabStoreApi],
  );

  const handleOpenRemoteConnection = useCallback(
    (preference?: RemoteConnectionOpenPreference) => {
      if (
        preference?.returnTarget &&
        (remoteConnectionInProgress ||
          (deviceAdditionReturn.current && !deviceAdditionReturn.current.completion))
      )
        return false;
      if (!remoteConnectionInProgress) {
        // 新入口替换尚在资格校验的旧返回，先解除旧 owner 的门禁，再使其迟到结果失效。
        deviceAdditionReturn.current?.target.onVisibilityChange?.(false);
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
        deviceAdditionReturn.current = preference?.returnTarget
          ? {
              target: preference.returnTarget,
              tabId: tabs.activeTabId,
              workspaceKey:
                tab?.kind === "workspace"
                  ? tab.workspaceIdentity?.trim() || tab.workspacePath
                  : undefined,
            }
          : null;
        // 返回目标曾被等同于新增设备，导致已有设备重连也切到设置。
        if (preference?.returnTarget?.kind === "add-device") {
          setPendingSettingsSectionIntent("remoteDevices");
          tabStoreApi.getState().openSettingsTab();
        }
      }
      // 明确入口与卡片恢复分离：空闲流程接受新意图，即使 Profile/目标值相同也重新读取。
      if (!remoteConnectionInProgress) {
        setRemoteConnectionOpenPreference(preference ?? null);
        setRemoteConnectionOpenIntentId((current) => current + 1);
      }
      deviceAdditionReturn.current?.target.onVisibilityChange?.(true);
      setRemoteConnectionDialogOpen(true);
    },
    [
      remoteConnectionInProgress,
      setRemoteConnectionDialogOpen,
      setRemoteConnectionOpenIntentId,
      setRemoteConnectionOpenPreference,
      tabStoreApi,
    ],
  );

  return { deviceAdditionReturn, finishDeviceAddition, handleOpenRemoteConnection };
}
