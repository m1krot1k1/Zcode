// SSH P0 传输 fixture：真实 SSH 控制命令、replay tunnel、首连接暂停代理与 Host 进程探针。
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Client as SSHClient, type ClientChannel, type TcpConnectionDetails } from "ssh2";
import { resolveSeededReplayBaseUrl } from "../custom-openai-provider-store.js";
import type { SSHConnectionConfig, SSHRuntimeConfig } from "./config.js";

const SSH_CONTROL_HANDSHAKE_TIMEOUT_MS = 30_000;
const SSH_CONTROL_COMMAND_TIMEOUT_MS = 60_000;

export interface ReplayTunnel {
  baseURL: string;
  close(): Promise<void>;
}

export interface SSHReplayTunnelOptions {
  username?: string;
  // 让远端监听与本机 replay server 相同的端口号。这样远端 Agent 用本机下发的
  // provider baseURL（http://127.0.0.1:<replayPort>）就能直接命中 replay server，
  // case 不必再自建 provider——给那些沿用默认 replay provider 的 case（share）用。
  mirrorLocalPort?: boolean;
}

export interface FirstConnectionStallingSSHProxy {
  firstConnectionAccepted: Promise<void>;
  port: number;
  waitForFirstConnectionClosed(): Promise<void>;
  close(): Promise<void>;
}

export async function createFirstConnectionStallingSSHProxy(
  config: Pick<SSHRuntimeConfig, "host" | "port">,
  caseMarker: string,
): Promise<FirstConnectionStallingSSHProxy> {
  let markFirstConnectionAccepted!: () => void;
  const firstConnectionAccepted = new Promise<void>((resolve) => {
    markFirstConnectionAccepted = resolve;
  });
  let markFirstConnectionClosed!: () => void;
  const firstConnectionClosed = new Promise<void>((resolve) => {
    markFirstConnectionClosed = resolve;
  });
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    trackSocket(client);
    connectionCount += 1;
    if (connectionCount === 1) {
      // 第一个 TCP connection 故意不转发 SSH 握手，稳定保留 pending cancel 窗口。
      // Bug 原因：只挂 close 监听不读取 socket，连接会一直停在 paused 状态，客户端
      // banner 与随后的 FIN 都留在内核缓冲里，end/close 永不触发，取消后的关闭事实
      // 就观测不到。这里 resume() 丢弃客户端数据（不转发上游），只为让 FIN 可被观测。
      client.resume();
      markFirstConnectionAccepted();
      client.once("error", () => client.destroy());
      client.once("close", markFirstConnectionClosed);
      return;
    }

    const upstream = createConnection({ host: config.host, port: config.port });
    trackSocket(upstream);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  const port = await listenOnLoopback(server, caseMarker);

  return {
    firstConnectionAccepted,
    port,
    waitForFirstConnectionClosed: () => firstConnectionClosed,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

export async function runSSHCommand(
  config: SSHConnectionConfig,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const client = await connectSSHClient(config);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? SSH_CONTROL_COMMAND_TIMEOUT_MS;
      let timedOut = false;
      // 截止必须覆盖 exec ACK；只在拿到 channel 后计时仍会被失联连接永久占住。
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`SSH 控制命令超过 ${timeoutMs}ms；目标命令未完成`));
        client.destroy();
      }, timeoutMs);
      client.exec(command, (error, channel) => {
        if (timedOut) {
          channel?.destroy();
          return;
        }
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        collectSSHChannel(channel).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    });
  } finally {
    clearTimeout(timer);
    client.end();
  }
}

export async function createSSHReplayTunnel(
  config: SSHConnectionConfig,
  caseMarker: string,
  options: SSHReplayTunnelOptions = {},
): Promise<ReplayTunnel> {
  const replayBaseURL = await resolveSeededReplayBaseUrl();
  if (!replayBaseURL) {
    throw new Error(`${caseMarker}: 没有找到本轮 replay provider URL`);
  }
  const replayURL = new URL(replayBaseURL);
  const replayPort = Number.parseInt(replayURL.port, 10);
  if (!Number.isSafeInteger(replayPort) || replayPort < 1) {
    throw new Error(`${caseMarker}: replay provider URL 缺少有效端口`);
  }

  const client = new SSHClient();
  client.on("tcp connection", (_details: TcpConnectionDetails, accept) => {
    const channel = accept();
    const socket = createConnection({
      host: replayURL.hostname,
      port: replayPort,
    });
    const closeBoth = () => {
      channel.destroy();
      socket.destroy();
    };
    channel.once("error", closeBoth);
    socket.once("error", closeBoth);
    socket.once("connect", () => channel.pipe(socket).pipe(channel));
    socket.once("close", () => channel.destroy());
    channel.once("close", () => socket.destroy());
  });

  const remotePort = await new Promise<number>((resolve, reject) => {
    client.once("error", reject);
    client.once("ready", () => {
      client.forwardIn(
        "127.0.0.1",
        options.mirrorLocalPort ? replayPort : 0,
        (error, assignedPort) => {
          if (error) reject(error);
          else resolve(options.mirrorLocalPort ? replayPort : assignedPort);
        },
      );
    });
    client.connect(
      toSSHConnectOptions(
        options.username && options.username !== config.username
          ? { ...config, username: options.username }
          : config,
      ),
    );
  });

  return {
    baseURL: `http://127.0.0.1:${remotePort}`,
    close: () =>
      new Promise<void>((resolve) => {
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          client.end();
          client.destroy();
          resolve();
        };
        const timer = setTimeout(finish, 2_000);
        client.unforwardIn("127.0.0.1", remotePort, finish);
      }),
  };
}

export async function readHostProcesses(): Promise<Array<{ name: string; pid: number }>> {
  // utilityProcess 的 serviceName 在 Main 的 metrics.name 中公开；只读同一权威 PID。
  // 打开资源管理器会抢业务窗口焦点并让失败录像录到探针本身，尤其影响短回合/soak。
  let hosts: Array<{ name: string; pid: number }> = [];
  await browser.waitUntil(
    async () => {
      hosts = await browser.electron.execute((electron) =>
        electron.app
          .getAppMetrics()
          .filter((metric) => metric.name?.startsWith("zcode-host-"))
          .map((metric) => ({ name: metric.name!, pid: metric.pid }))
          .sort((a, b) => a.pid - b.pid),
      );
      return hosts.length > 0;
    },
    { timeout: 15_000, interval: 200, timeoutMsg: "Main 进程指标未出现 Window Host" },
  );
  return hosts;
}

function listenOnLoopback(server: Server, caseMarker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`${caseMarker}: 无法解析 SSH pending proxy 监听端口`));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function connectSSHClient(config: SSHConnectionConfig): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    client.once("error", reject);
    client.once("ready", () => resolve(client));
    client.connect(toSSHConnectOptions(config));
  });
}

function toSSHConnectOptions(config: SSHConnectionConfig) {
  return {
    host: config.host,
    password: config.password,
    port: config.port,
    readyTimeout: SSH_CONTROL_HANDSHAKE_TIMEOUT_MS,
    username: config.username,
  };
}

function collectSSHChannel(
  channel: ClientChannel,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    channel.on("data", (chunk: string) => {
      stdout += chunk;
    });
    channel.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    channel.once("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.once("error", reject);
    channel.once("close", () => resolve({ code: exitCode, stderr, stdout }));
  });
}
