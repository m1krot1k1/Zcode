// transport flow state 到 base service 的顺序化转发与 attachment route 登记。
import type { V4ConnectionFlowState } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";
import type { OwnedSubscription } from "./types.js";
import type { OwnershipRegistry } from "./ownership.js";
import { withTrustedConnection, workspaceKey, workspaceTarget } from "./trustedConnection.js";
import type { ConnectionFlowRoute } from "./types.js";

export function flowRouteKey(target: ZCodeAgentWorkspaceTarget, connectionId: string): string {
  return `${workspaceKey(target)}\0${connectionId}`;
}

export interface FlowControlRegistry {
  enqueue(state: V4ConnectionFlowState): Promise<void>;
  isClosed(): boolean;
  currentState(): V4ConnectionFlowState;
  syncCurrentFlowForEntry(entry: OwnedSubscription): Promise<void>;
  forwardRoute(route: ConnectionFlowRoute, state: V4ConnectionFlowState): Promise<void>;
  closeUnusedFlowRoute(entry: OwnedSubscription): Promise<void>;
  registerAttachmentRoute(route: ConnectionFlowRoute): void;
  dropAttachmentRoute(key: string): void;
  ownsRoute(target: ZCodeAgentWorkspaceTarget, connectionId: string): boolean;
  dropRoutesForWorkspace(invalidatedWorkspaceKey: string): void;
  clear(): void;
}

export function createFlowControlRegistry(
  base: Pick<IZCodeAgentService, "setConnectionFlowStateV4">,
  ownership: Pick<OwnershipRegistry, "entries">,
  isDisposed: () => boolean,
): FlowControlRegistry {
  let currentTransportFlowState: V4ConnectionFlowState = "drained";
  let flowClosed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardedFlowStateByRoute = new Map<string, V4ConnectionFlowState>();
  /** attachment 曾触及的 workspace route 留到 port dispose，保证无 subscription 也能 trusted closed。 */
  const attachmentFlowRoutes = new Map<string, ConnectionFlowRoute>();

  const flowRouteForEntry = (entry: OwnedSubscription): ConnectionFlowRoute => ({
    key: flowRouteKey(entry.target, entry.connectionId),
    target: entry.target,
    connection: {
      connectionId: entry.connectionId,
      clientMode: entry.clientMode,
    },
  });
  const currentFlowRoutes = () => {
    const routes = new Map<string, ConnectionFlowRoute>(attachmentFlowRoutes);
    for (const entry of ownership.entries()) {
      const route = flowRouteForEntry(entry);
      routes.set(route.key, route);
    }
    return routes;
  };
  const forwardFlowRoute = async (
    route: ConnectionFlowRoute,
    state: V4ConnectionFlowState,
  ): Promise<void> => {
    if (forwardedFlowStateByRoute.get(route.key) === state) return;
    await base.setConnectionFlowStateV4(
      withTrustedConnection(
        {
          ...workspaceTarget(route.target),
          state,
        },
        route.connection,
      ),
    );
    forwardedFlowStateByRoute.set(route.key, state);
  };
  const applyTransportFlowState = async (state: V4ConnectionFlowState): Promise<void> => {
    if (flowClosed && state !== "closed") return;
    currentTransportFlowState = state;
    if (state === "closed") flowClosed = true;
    for (const route of currentFlowRoutes().values()) {
      await forwardFlowRoute(route, state);
    }
  };
  const enqueueTransportFlowState = (state: V4ConnectionFlowState): Promise<void> => {
    if (isDisposed() || (flowClosed && state !== "closed")) return Promise.resolve();
    const update = flowUpdateChain.then(() => applyTransportFlowState(state));
    // 快速 SAT→DRN 与 close 必须保持提交顺序；单次 RPC 失败不能打断后续
    // close 清理，但调用方仍会收到该次 update 的 rejection。
    flowUpdateChain = update.catch(() => {});
    return update;
  };
  const syncCurrentFlowForEntry = async (entry: OwnedSubscription): Promise<void> => {
    if (currentTransportFlowState !== "saturated") return;
    await forwardFlowRoute(flowRouteForEntry(entry), "saturated");
  };
  const closeUnusedFlowRoute = async (entry: OwnedSubscription): Promise<void> => {
    const route = flowRouteForEntry(entry);
    if (currentFlowRoutes().has(route.key)) return;
    if (forwardedFlowStateByRoute.has(route.key)) {
      await forwardFlowRoute(route, "closed");
      forwardedFlowStateByRoute.delete(route.key);
    }
  };
  const ownsRoute = (target: ZCodeAgentWorkspaceTarget, connectionId: string): boolean =>
    attachmentFlowRoutes.has(flowRouteKey(target, connectionId)) ||
    ownership
      .entries()
      .some(
        (entry) =>
          workspaceKey(entry.target) === workspaceKey(target) &&
          entry.connectionId === connectionId,
      );

  return {
    enqueue: enqueueTransportFlowState,
    isClosed: () => flowClosed,
    currentState: () => currentTransportFlowState,
    syncCurrentFlowForEntry,
    forwardRoute: forwardFlowRoute,
    closeUnusedFlowRoute,
    registerAttachmentRoute: (route) => {
      attachmentFlowRoutes.set(route.key, route);
    },
    dropAttachmentRoute: (key) => {
      attachmentFlowRoutes.delete(key);
    },
    ownsRoute,
    dropRoutesForWorkspace: (invalidatedWorkspaceKey) => {
      for (const key of forwardedFlowStateByRoute.keys()) {
        if (key.startsWith(`${invalidatedWorkspaceKey}\0`)) {
          forwardedFlowStateByRoute.delete(key);
        }
      }
    },
    clear: () => {
      attachmentFlowRoutes.clear();
      forwardedFlowStateByRoute.clear();
    },
  };
}
