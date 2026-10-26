import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_OPENCODE_MODEL_ID = "opencode/deepseek-v4.1-flash-free";
/** Ответ mock OpenCode server для Composer (AI SDK path), не ACP panel. */
export const E2E_OPENCODE_REPLY = "E2E_OPENCODE_COMPOSER_REPLY";
export const E2E_OPENCODE_COMPOSER_TRACE_FILE =
  "conversation-session-opencode-cli-composer/composer-trace.jsonl";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

/**
 * Устанавливает изолированный `opencode` CLI для Desktop E2E: `models --verbose` и `serve` (HTTP),
 * как ожидает ai-sdk-provider-opencode-sdk. Не трогает системный OpenCode.
 */
export async function installOpenCodeCliE2EFixture(
  homeDir: string,
  tracePath: string,
): Promise<string> {
  const binDir = join(homeDir, ".opencode", "bin");
  await mkdir(binDir, { recursive: true });
  const require = createRequire(import.meta.url);
  // Сохраняем для совместимости с wdio hook (раньше тянул ACP SDK).
  void require.resolve("@agentclientprotocol/sdk");

  const sourceFixture = join(fixtureDir, "open-code-cli-e2e-fixture.mjs");
  const cliPath = join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  if (process.platform === "win32") {
    await copyFile(sourceFixture, cliPath);
  } else {
    // Host PATH после запуска Electron не содержит node, поэтому `#!/usr/bin/env node` не стартует.
    // Shebang с абсолютным execPath воркера не зависит от PATH.
    const source = await readFile(sourceFixture, "utf8");
    const rewritten = source.replace(/^#![^\n]*\n/, `#!${process.execPath}\n`);
    await writeFile(cliPath, rewritten, { mode: 0o700 });
    await chmod(cliPath, 0o700);
  }

  process.env.ZCODE_E2E_OPENCODE_TRACE_PATH = tracePath;
  process.env.ZCODE_E2E_OPENCODE_MODEL_ID = E2E_OPENCODE_MODEL_ID;
  process.env.ZCODE_E2E_OPENCODE_REPLY = E2E_OPENCODE_REPLY;
  // SDK-manager обычно использует 4096; на машине пользователя там может уже работать OpenCode.
  // Выделяем свободный порт для mock, чтобы E2E никогда не отправлял prompt реальному серверу.
  process.env.ZCODE_E2E_OPENCODE_PORT = String(await reserveLocalPort());

  return binDir;
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Не удалось выделить локальный порт для OpenCode E2E");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** @deprecated Используйте installOpenCodeCliE2EFixture — прежнее имя из ACP-only эпохи. */
export const installOpenCodeAcpFixture = installOpenCodeCliE2EFixture;
