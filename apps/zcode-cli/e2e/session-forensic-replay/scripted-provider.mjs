/**
 * Локальный скриптованный OpenAI-совместимый провайдер.
 *
 * Записывает каждый входящий запрос (включая полное тело) и отдаёт
 * детерминированный ответ по номеру запроса. Сеть и ключи не нужны.
 */
import http from "node:http";
import { writeFile } from "node:fs/promises";

const LOCALHOST = "127.0.0.1";
const MAX_CAPTURE_BODY_CHARS = 400_000;

export async function startScriptedProvider({ handler, name }) {
  const records = [];
  const server = http.createServer(async (request, response) => {
    const startedMs = Date.now();
    const requestBody = await readRequestBody(request);
    let requestJson;
    try {
      requestJson = JSON.parse(requestBody);
    } catch {
      requestJson = undefined;
    }
    try {
      const scripted = await handler({
        body: requestJson,
        method: request.method,
        rawBody: requestBody,
        url: request.url ?? "/",
      });
      const responseBody = scripted.bodyText ?? JSON.stringify(scripted.body);
      const responseHeaders = scripted.headers ?? { "content-type": "application/json" };
      records.push({
        durationMs: Date.now() - startedMs,
        requestBody: truncate(requestBody),
        responseBody: truncate(responseBody),
        status: scripted.status ?? 200,
        url: request.url,
      });
      response.writeHead(scripted.status ?? 200, responseHeaders);
      response.end(responseBody);
    } catch (error) {
      const responseBody = JSON.stringify({ error: { message: String(error) } });
      records.push({
        error: error instanceof Error ? error.message : String(error),
        requestBody: truncate(requestBody),
        responseBody,
        status: 500,
        url: request.url,
      });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(responseBody);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Скриптованный провайдер не получил TCP-порт");
  }

  return {
    baseURL: `http://${LOCALHOST}:${address.port}`,
    name,
    records,
    server,
  };
}

export async function stopScriptedProvider(provider) {
  if (!provider) return;
  await new Promise((resolve, reject) => {
    provider.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function writeCapture(provider, capturePath) {
  if (!provider) return undefined;
  await writeFile(
    capturePath,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), records: provider.records }, null, 2)}\n`,
  );
  return capturePath;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function truncate(body) {
  if (body.length <= MAX_CAPTURE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_CAPTURE_BODY_CHARS)}...<capture truncated>`;
}
