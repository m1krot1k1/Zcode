import { ipcRenderer } from "electron";
import {
  InternalChannels,
  PlatformChannels,
  databaseStartupControlSchema,
  databaseStartupPortPayloadSchema,
  databaseStartupStateSchema,
  scopedServicePortPayloadSchema,
} from "@zcode/shared";

/**
 * MessagePort 不能通过 contextBridge 传递（contextBridge 会把它包成 Proxy，
 * 丢失 addEventListener 等原生方法）。改用 window.postMessage 的 transfer
 * 机制将 MessagePort 原样传递到 renderer 的 window context 中。
 */
export function installServicePortBridge(): void {
  ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
    const [port] = event.ports;
    const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
    if (port && parsed.success)
      window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
    else port?.close();
  });

  ipcRenderer.on(InternalChannels.ScopedServicePort, (event, payload: unknown) => {
    const [port] = event.ports;
    const parsed = scopedServicePortPayloadSchema.safeParse(payload);
    if (!port || !parsed.success) return;
    // Bug 根因：这里曾用手工字段白名单重建 payload；Main 新增 workspace scope 后
    // Preload 未同步白名单，Renderer 因而把 project logical session 原地绑定成 conversation。
    window.postMessage(
      {
        type: InternalChannels.ScopedServicePort,
        ...parsed.data,
      },
      "*",
      [port],
    );
  });

  ipcRenderer.on(
    InternalChannels.SourceSettingsServicePort,
    (
      event,
      payload: {
        attachmentId?: string;
        sourceServerId?: string;
      },
    ) => {
      const [port] = event.ports;
      if (!port) return;
      window.postMessage(
        {
          type: InternalChannels.SourceSettingsServicePort,
          attachmentId: payload.attachmentId,
          sourceServerId: payload.sourceServerId,
        },
        "*",
        [port],
      );
    },
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window || typeof event.data !== "object" || event.data === null) {
      return;
    }
    const payload = event.data as {
      type?: unknown;
      attachmentId?: unknown;
      sessionId?: unknown;
    };
    if (
      payload.type !== InternalChannels.ScopedServicePortReady ||
      typeof payload.attachmentId !== "string" ||
      !payload.attachmentId ||
      typeof payload.sessionId !== "string" ||
      !payload.sessionId
    ) {
      return;
    }
    // MessagePort 注册发生在隔离的 renderer world，Main 不能把“已投递”误当作“已可用”。
    // preload 只把 renderer 的 ready ACK 薄转发给 Main，业务 attachment 状态仍由窗口 session manager 管理。
    ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
      attachmentId: payload.attachmentId,
      sessionId: payload.sessionId,
    });
  });

  ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
    window.postMessage(InternalChannels.TaskNotificationSound, "*");
  });
}

/** 启动控制面：数据库启动状态镜像与 Host 退出通知的单向转发。 */
export function installStartupControlBridge(): void {
  // 启动控制面先于普通 RPC；reload 从 Main 的通知镜像补齐，不触发新迁移。
  ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
    const parsed = databaseStartupStateSchema.safeParse(raw);
    if (parsed.success)
      window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
  });

  // Host 意外退出是运行期故障，不是启动期 schema；只做最小形状校验，避免把任意 IPC 数据当 UI 文案。
  ipcRenderer.on(InternalChannels.HostProcessExited, (_event, raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const notification = raw as { label?: unknown; willRespawn?: unknown; at?: unknown };
    if (typeof notification.label !== "string" || typeof notification.willRespawn !== "boolean")
      return;
    window.postMessage({ type: InternalChannels.HostProcessExited, notification }, "*");
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
      return;
    const parsed = databaseStartupControlSchema.safeParse(event.data.control);
    if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
  });
}
