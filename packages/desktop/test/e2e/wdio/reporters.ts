import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMeasuredE2ELifecyclePhase } from "../helpers/e2e-lifecycle-measurement.js";
import { createE2EReporter } from "../reporting/e2e-reporting.js";
import type { E2ELifecyclePhase } from "../reporting/e2e-reporting-types.js";
import { DESKTOP_DIR, REPO_ROOT } from "./paths.js";
import { containerE2E, requestedE2ESpecs } from "./specs.js";

export const e2eReporter: ReturnType<typeof createE2EReporter> = createE2EReporter({
  repoRoot: REPO_ROOT,
  desktopDir: DESKTOP_DIR,
  requestedSpecs: requestedE2ESpecs,
  containerE2E,
});
// Reporter выставляет ZCODE_E2E_RUN_ID при инициализации (см. createE2EReporter).
function requireE2ERunId(): string {
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!runId) {
    throw new Error("[e2e] ZCODE_E2E_RUN_ID missing after reporter initialization");
  }
  return runId;
}

export const E2E_RUN_ID = requireE2ERunId();
export const E2E_RUN_CACHE_DIR = resolve(DESKTOP_DIR, ".e2e-cache", E2E_RUN_ID);
export const E2E_APP_OUTPUT_DIR = resolve(E2E_RUN_CACHE_DIR, "app");
export const E2E_APP_ENTRY_POINT = resolve(E2E_APP_OUTPUT_DIR, "main/index.js");
export const E2E_APP_RENDERER_ASSETS_DIR = resolve(E2E_APP_OUTPUT_DIR, "renderer/assets");
const E2E_REMOTE_ASSET_VERSION = String(
  (
    JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
      version?: string;
    }
  ).version ?? "",
).trim();
export const E2E_REMOTE_RELEASE_SOURCE_DIR = resolve(
  DESKTOP_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
export const E2E_REMOTE_RELEASE_OUTPUT_DIR = resolve(
  E2E_RUN_CACHE_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
export const E2E_CHROMIUM_USER_DATA_ROOT_DIR = resolve(E2E_RUN_CACHE_DIR, "chromium-profiles");

export async function measureE2ELifecyclePhase<T>(
  phase: E2ELifecyclePhase,
  context: { cid?: string; specs?: string[] },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runMeasuredE2ELifecyclePhase(phase, context, e2eReporter.recordLifecycleEvent, run);
}

export async function runE2EDiagnosticWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
