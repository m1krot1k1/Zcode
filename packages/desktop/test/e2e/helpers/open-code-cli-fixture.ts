import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const E2E_OPENCODE_MODEL_ID = "opencode/deepseek-v4.1-flash-free";
export const E2E_OPENCODE_REPLY = "E2E_OPENCODE_ACP_REPLY";

/**
 * 安装仅供隔离 Desktop E2E 使用的 ACP CLI；不触碰真实 HOME 或系统 OpenCode。
 */
export async function installOpenCodeAcpFixture(
  homeDir: string,
  tracePath: string,
): Promise<string> {
  const binDir = join(homeDir, ".opencode", "bin");
  await mkdir(binDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const sdkUrl = pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href;
  const script = `#!/usr/bin/env node
import * as acp from ${JSON.stringify(sdkUrl)};
import { appendFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
const modelId = ${JSON.stringify(E2E_OPENCODE_MODEL_ID)};
const tracePath = ${JSON.stringify(tracePath)};
const trace = async (entry) => appendFile(tracePath, JSON.stringify(entry) + "\\n");
if (process.argv[2] === "--version") {
  process.stdout.write("OpenCode E2E fixture 1.0.0\\n");
} else if (process.argv[2] === "models") {
  process.stdout.write(modelId + "\\n");
} else {
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  new acp.AgentSideConnection((connection) => ({
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } };
    },
    async newSession(params) {
      await trace({ event: "session/new", cwd: params.cwd });
      return {
        sessionId: "e2e-opencode-session",
        configOptions: [{
          id: "model", name: "Model", category: "model", type: "select", currentValue: modelId,
          options: [{ value: modelId, name: modelId }],
        }],
      };
    },
    async setSessionConfigOption(params) {
      await trace({ event: "model", configId: params.configId, modelId: params.value });
      return { configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: params.value,
        options: [{ value: modelId, name: modelId }],
      }] };
    },
    async prompt(params) {
      const prompt = params.prompt.map((item) => item.text ?? "").join("");
      await trace({ event: "prompt", prompt });
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(E2E_OPENCODE_REPLY)} } },
      });
      return { stopReason: "end_turn" };
    },
    async cancel() { return {}; },
    async closeSession() { return {}; },
  }), stream);
}
`;
  const cliPath = join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(cliPath, script, { encoding: "utf8", mode: 0o700 });
  if (process.platform !== "win32") await chmod(cliPath, 0o700);
  return binDir;
}
