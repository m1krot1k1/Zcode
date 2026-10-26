#!/usr/bin/env node
/**
 * Minimal OpenCode CLI stub for Desktop E2E (Composer + opencode-sdk provider).
 * Env: ZCODE_E2E_OPENCODE_MODEL_ID, ZCODE_E2E_OPENCODE_REPLY, ZCODE_E2E_OPENCODE_TRACE_PATH
 */
import http from "node:http";
import { appendFile } from "node:fs/promises";

const modelId = process.env.ZCODE_E2E_OPENCODE_MODEL_ID ?? "opencode/deepseek-v4.1-flash-free";
const reply = process.env.ZCODE_E2E_OPENCODE_REPLY ?? "E2E_OPENCODE_COMPOSER_REPLY";
const tracePath = process.env.ZCODE_E2E_OPENCODE_TRACE_PATH;

async function trace(entry) {
  if (!tracePath) return;
  await appendFile(tracePath, `${JSON.stringify(entry)}\n`);
}

const args = process.argv.slice(2);
const sub = args[0];

if (args.includes("--version") || sub === "--version") {
  process.stdout.write("OpenCode E2E fixture 1.0.0\n");
  process.exit(0);
}

if (sub === "models" && args.includes("--verbose")) {
  const [providerID, id] = modelId.includes("/") ? modelId.split("/", 2) : ["opencode", modelId];
  const meta = {
    id,
    providerID,
    name: modelId,
    limit: { context: 128_000, output: 8_000 },
    capabilities: {
      input: { text: true, image: false, video: false, audio: false, pdf: false },
      output: { text: true, image: false, video: false, audio: false, pdf: false },
    },
  };
  process.stdout.write(`${modelId}\n${JSON.stringify(meta, null, 2)}\n`);
  process.exit(0);
}

if (sub === "serve") {
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : 4096;
  const hostnameArg = args.find((a) => a.startsWith("--hostname="));
  const hostname = hostnameArg?.split("=")[1] ?? "127.0.0.1";
  let sessionCounter = 0;
  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();
  let pendingSse = "";
  const publish = (payload) => {
    pendingSse += payload;
    for (const client of sseClients) client.write(payload);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/health" || url.pathname === "/global/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      if (url.pathname === "/config" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.pathname === "/session" && req.method === "POST") {
        const id = `e2e-session-${++sessionCounter}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
        return;
      }
      if ((url.pathname === "/event" || url.pathname === "/global/event") && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (pendingSse) res.write(pendingSse);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/(?:message|prompt_async)$/);
      if (messageMatch && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        /** @type {{ parts?: Array<{ text?: string }> }} */
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          payload = {};
        }
        const promptText = (payload.parts ?? []).map((p) => p.text ?? "").join("");
        await trace({ event: "prompt", prompt: promptText, model: payload.model ?? null });
        const sessionId = messageMatch[1];
        const messageId = "msg-assistant-1";
        const partId = "part-text-1";
        const events = [
          {
            type: "message.updated",
            properties: {
              info: { id: messageId, role: "assistant", sessionID: sessionId },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: partId,
                type: "text",
                sessionID: sessionId,
                messageID: messageId,
                text: reply,
              },
            },
          },
          {
            type: "session.status",
            properties: {
              sessionID: sessionId,
              status: { type: "idle" },
            },
          },
        ];
        publish(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              info: { id: messageId, role: "assistant", sessionID: sessionId },
              parts: [
                {
                  id: partId,
                  type: "text",
                  sessionID: sessionId,
                  messageID: messageId,
                  text: reply,
                },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });

  server.listen(port, hostname, () => {
    process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
  });
} else {
  process.stderr.write(`Unsupported OpenCode E2E fixture invocation: ${args.join(" ")}\n`);
  process.exit(1);
}
