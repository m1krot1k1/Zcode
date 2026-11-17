import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { CodeIndexService } from "./indexService.js";
import { parseWorkerRequest } from "./workerProtocol.js";
import { initTreeSitter } from "../ast/parserPool.js";

/**
 * Транспортный слой воркера: единственная ответственность — принимать сообщения,
 * валидировать их Zod-схемой и делегировать в `CodeIndexService`.
 *
 * Вся работа с SQLite/AST живёт в `indexService.ts`, поэтому тот же код исполняется
 * в in-process режиме (тесты, бенчмарк) без расхождения поведения.
 */

interface WorkerInitData {
  indexRootDir?: string;
}

const initData = (workerData ?? {}) as WorkerInitData;
const indexRootDir = initData.indexRootDir ?? join(process.cwd(), ".zcode-code-index");

if (!isMainThread && parentPort) {
  const port = parentPort;
  const service = new CodeIndexService({
    indexRootDir,
    onProgress: (progress) => port.postMessage({ type: "event", event: "progress", progress }),
  });

  port.on("message", (raw: unknown) => {
    const request = parseWorkerRequest(raw);
    if (!request) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === "number") {
        port.postMessage({
          type: "result",
          id,
          ok: false,
          error: { message: "Invalid worker request", code: "invalid-request" },
        });
      }
      return;
    }
    void service.handle(request).then((outcome) => {
      port.postMessage(
        outcome.ok
          ? { type: "result", id: request.id, ok: true, value: outcome.value }
          : { type: "result", id: request.id, ok: false, error: outcome.error },
      );
    });
  });

  // Прогрев грамматик, чтобы первый файл не платил за `Language.load`.
  void initTreeSitter();
}
