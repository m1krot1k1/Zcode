/* mock 网关的开关、环境变量覆盖与默认配置。 */
import type { OffPeakMockGatewayOptions } from "./types.js";

/** 固定端口（可用 ZCODE_OFFPEAK_MOCK_PORT 覆盖）：多窗口多 host 时共享同一份 mock 票据状态。 */
export const DEFAULT_MOCK_PORT = 45_197;

export type OffPeakMockGatewayStartOptions = OffPeakMockGatewayOptions & { port?: number };

export type MockGatewayConfig = Required<Omit<OffPeakMockGatewayOptions, "scenario">> &
  Pick<OffPeakMockGatewayOptions, "scenario">;

export function isOffPeakMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ZCODE_OFFPEAK_MOCK"] === "1";
}

/** 环境变量覆盖数值选项（真机演示用；测试直接传 options）。 */
function readEnvOptions(env: NodeJS.ProcessEnv): OffPeakMockGatewayOptions {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const scenarioValue = env["ZCODE_OFFPEAK_MOCK_SCENARIO"];
  const scenario =
    scenarioValue === "foreground-subagents" ||
    scenarioValue === "capture" ||
    scenarioValue === "invalid-ticket"
      ? scenarioValue
      : undefined;
  return {
    ...(num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") !== undefined
      ? { readyDelayMs: num("ZCODE_OFFPEAK_MOCK_READY_DELAY_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") !== undefined
      ? { readyTtlMs: num("ZCODE_OFFPEAK_MOCK_READY_TTL_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") !== undefined
      ? { activeMs: num("ZCODE_OFFPEAK_MOCK_ACTIVE_MS") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") !== undefined
      ? { queue429Count: num("ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") !== undefined
      ? { quotaExhaustedCount: num("ZCODE_OFFPEAK_MOCK_QUOTA_COUNT") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS") !== undefined
      ? {
          availabilityBlockedMs: num("ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS"),
        }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") !== undefined
      ? { retryAfterS: num("ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S") }
      : {}),
    ...(num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") !== undefined
      ? { nextPollS: num("ZCODE_OFFPEAK_MOCK_NEXT_POLL_S") }
      : {}),
    ...(scenario ? { scenario } : {}),
  };
}

/** 默认值 < 环境变量 < 显式 options；port 由调用方单独读取。 */
export function resolveMockGatewayConfig(
  options: OffPeakMockGatewayStartOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): MockGatewayConfig {
  return {
    readyDelayMs: 15_000,
    readyTtlMs: 5 * 60_000,
    activeMs: 3 * 60 * 60_000,
    queue429Count: 0,
    quotaExhaustedCount: 0,
    availabilityBlockedMs: 0,
    retryAfterS: 5,
    nextPollS: 5,
    ...readEnvOptions(env),
    ...options,
  };
}
