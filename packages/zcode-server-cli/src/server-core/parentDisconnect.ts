interface ParentDisconnectSource {
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/**
 * 注册 Core 对 Supervisor IPC 断连的清理钩子。
 *
 * Supervisor 被强杀时不会再发送 shutdown command，Core 仍需主动收口自己的
 * HTTP/WebSocket 和 Agent 资源，否则它会绕过 data-root lock 成为孤儿进程。
 */
export function installParentDisconnectHandler(
  onDisconnect: () => void | Promise<void>,
  source: ParentDisconnectSource = process,
): () => void {
  const handler = (): void => {
    void onDisconnect();
  };
  source.once("disconnect", handler);
  return () => source.off("disconnect", handler);
}

interface StdinDisconnectSource {
  isTTY?: boolean;
  once(event: "end" | "close", listener: () => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  /** A pipe stdin starts paused; without flowing mode Node never delivers EOF. */
  resume?(): unknown;
}

export interface StdinDisconnectOptions {
  /**
   * The parent IPC marker. A supervisor-launched Core is stopped explicitly over IPC and
   * keeps its stdin unused, so watching it there would be both useless and unsafe.
   */
  hasParentChannel: boolean;
  source?: StdinDisconnectSource;
}

/**
 * Core, запущенный напрямую удалённым клиентом (`node zcode-server.cjs` через SSH/WSL),
 * не имеет IPC-родителя: единственный признак того, что клиент ушёл, — EOF на stdin.
 *
 * Без этого хука закрытие канала оставляло Core сиротой: он продолжал держать
 * HTTP/WebSocket, SQLite и задачи, хотя связь с клиентом уже невозможна.
 * Действует только при отсутствии IPC-канала; Supervisor останавливает Core командой.
 */
export function installStdinCloseHandler(
  onClose: () => void | Promise<void>,
  options: StdinDisconnectOptions,
): () => void {
  if (options.hasParentChannel) return () => undefined;
  const source = options.source ?? process.stdin;
  // Терминал не сигнализирует EOF при закрытии окна; там работает SIGTERM/SIGINT.
  if (source.isTTY === true) return () => undefined;
  let closed = false;
  const handler = (): void => {
    if (closed) return;
    closed = true;
    void onClose();
  };
  source.once("end", handler);
  source.once("close", handler);
  // Pipe stdin is paused until someone reads it, and a paused stream never emits EOF.
  // In this mode stdin carries no protocol data, it is the lifetime channel.
  source.resume?.();
  return () => {
    source.off("end", handler);
    source.off("close", handler);
  };
}
