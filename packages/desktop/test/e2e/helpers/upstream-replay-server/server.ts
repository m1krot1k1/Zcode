import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { writeE2EJsonFileAtomically } from "../e2e-atomic-json-file.js";
import type { E2ENetworkCaptureArtifact } from "../network-capture-proxy.js";
import { loadFixtureFile } from "./fixtures.js";
import { closeReplayResponseAfterHandlerError, handleReplayRequest } from "./routes.js";
import type {
  MutableCaptureRecord,
  StartUpstreamReplayServerOptions,
  UpstreamReplayServer,
} from "./types.js";

export async function startUpstreamReplayServer(
  options: StartUpstreamReplayServerOptions,
): Promise<UpstreamReplayServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const artifactPath = resolve(options.artifactPath);
  const artifactWriter = options.artifactWriter ?? writeE2EJsonFileAtomically;
  // Bug 根因：provider fixture 里的绝对路径过去只能写死为 POSIX 临时目录，
  // Windows Node 与 Git Bash 因而会访问不同文件。静态变量必须在 matcher 之前展开，
  // 否则 response 虽能拿到正确路径，请求仍会先因 matcher 含 token 而 miss。
  const fixtures = options.fixturePaths.flatMap((path) =>
    loadFixtureFile(path, options.fixtureVariables),
  );
  for (const fixture of fixtures) {
    const count = fixture.response.releaseAfterChunks;
    if (count === undefined) continue;
    if (
      fixture.metadata?.timingPolicy !== "controlled-stream" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count >= (fixture.response.chunks?.length ?? 0) ||
      fixture.response.events?.length
    ) {
      throw new Error(`无效受控流 fixture: ${fixture.id}；不得改变 recorded/fault stream 的时间轴`);
    }
  }
  const fixtureMatchCounts = new Map<string, number>();
  const records: MutableCaptureRecord[] = [];
  const gates = new Map<string, { release(): void; cancel(): void }>();

  const holdStream = (id: string, response: ServerResponse) =>
    new Promise<void>((resolveGate, rejectGate) => {
      if (gates.has(id)) {
        rejectGate(new Error(`重复的受控请求: ${id}`));
        return;
      }
      const finish = (error?: Error) => {
        clearTimeout(timer);
        response.off("close", closed);
        gates.delete(id);
        if (error) rejectGate(error);
        else resolveGate();
      };
      const closed = () => finish(new Error(`受控流已断开: ${id}`));
      const timer = setTimeout(() => finish(new Error(`受控流未被测试释放: ${id}`)), 120_000);
      gates.set(id, { release: () => finish(), cancel: closed });
      response.once("close", closed);
    });

  let serverPort = requestedPort;
  let baseUrl = `http://${host}:${serverPort}`;
  let artifactWriteQueue = Promise.resolve();

  const writeArtifact = () => {
    const artifact = {
      generatedAt: new Date().toISOString(),
      proxy: {
        caCertPath: "",
        host,
        port: serverPort,
        proxyUrl: baseUrl,
      },
      records: records.map(serializeRecord),
      version: 1,
    } satisfies E2ENetworkCaptureArtifact;
    // 同一 replay server 内也必须串行替换 artifact；否则多个并发 child request
    // 会让各自的临时文件竞争目标路径，并可能把较旧快照写到较新快照之后。
    const nextWrite = artifactWriteQueue
      .catch(() => undefined)
      .then(() => artifactWriter(artifactPath, artifact));
    artifactWriteQueue = nextWrite;
    return nextWrite;
  };

  const server = createServer((request, response) => {
    // 控制端不进入模型请求台账；每个独立 replay server 只释放自己的正在等待的 fixture。
    if (request.method === "GET" && request.url === "/__e2e__/gates") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([...gates.keys()]));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/__e2e__/release/")) {
      const gate = gates.get(request.url.slice("/__e2e__/release/".length));
      response.statusCode = gate ? 204 : 409;
      gate?.release();
      response.end();
      return;
    }
    void handleReplayRequest(request, response, {
      baseUrl,
      fixtureMatchCounts,
      fixtures,
      records,
      writeArtifact,
      holdStream,
    }).catch((error: unknown) => {
      // Bug 根因：旧 handler 是裸 `void Promise`，capture 写入抛错后没有任何人
      // 收口 response，provider 只能一直等 socket。证据通道失败必须显式结束请求。
      closeReplayResponseAfterHandlerError(response, error);
    });
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.listen(requestedPort, host, () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        rejectStart(new Error("Upstream replay server did not expose an address"));
        return;
      }
      serverPort = address.port;
      baseUrl = `http://${host}:${serverPort}`;
      resolveStart();
    });
    server.once("error", rejectStart);
  });
  try {
    await writeArtifact();
  } catch (error) {
    // Bug 根因：listen 成功后首次 artifact 写入失败会直接退出启动流程，
    // 但旧实现没有关闭 HTTP server，导致端口和进程句柄跨测试泄漏。
    // 清理错误不能覆盖原始写入错误；同时显式等待队列收口再向调用方失败。
    await closeServerListener(server).catch(() => undefined);
    await artifactWriteQueue.catch(() => undefined);
    throw error;
  }

  return {
    artifactPath,
    baseUrl,
    host,
    port: serverPort,
    stop: () => {
      for (const gate of gates.values()) gate.cancel();
      return stopServer(server, writeArtifact);
    },
  };
}

function serializeRecord(record: MutableCaptureRecord): MutableCaptureRecord {
  return record;
}

async function stopServer(server: Server, writeArtifact: () => Promise<void>): Promise<void> {
  await closeServerListener(server);
  await writeArtifact();
}

async function closeServerListener(server: Server): Promise<void> {
  await new Promise<void>((resolveStop, rejectStop) => {
    server.close((error) => {
      if (error) {
        rejectStop(error);
        return;
      }
      resolveStop();
    });
  });
}
