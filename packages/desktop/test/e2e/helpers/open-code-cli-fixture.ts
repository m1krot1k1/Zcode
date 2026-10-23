import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_OPENCODE_MODEL_ID = "opencode/deepseek-v4.1-flash-free";
/** Ответ mock OpenCode server для Composer (AI SDK path), не ACP panel. */
export const E2E_OPENCODE_REPLY = "E2E_OPENCODE_COMPOSER_REPLY";

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
  await copyFile(sourceFixture, cliPath);
  if (process.platform !== "win32") await chmod(cliPath, 0o700);

  process.env.ZCODE_E2E_OPENCODE_TRACE_PATH = tracePath;
  process.env.ZCODE_E2E_OPENCODE_MODEL_ID = E2E_OPENCODE_MODEL_ID;
  process.env.ZCODE_E2E_OPENCODE_REPLY = E2E_OPENCODE_REPLY;

  return binDir;
}

/** @deprecated Используйте installOpenCodeCliE2EFixture — прежнее имя из ACP-only эпохи. */
export const installOpenCodeAcpFixture = installOpenCodeCliE2EFixture;
