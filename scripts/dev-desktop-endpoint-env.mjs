import { OFFLINE_PREVIEW_ZCODE_ENDPOINT } from "./preview-release-contract.mjs";

const ENDPOINT_ENV_NAMES = [
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "VITE_ZCODE_BASE_URL",
  "VITE_ZCODE_ENDPOINT_ORIGIN",
];

/**
 * `ZCODE_ENV=test` historically shares the production origin when no test origin is configured.
 * Keep ordinary local test launches offline; remote server calls require an explicit test origin
 * and opt-in so a missing test URL cannot silently send requests to the production service.
 */
export function resolveDevDesktopEndpointEnv(requestedEnv, sourceEnv = process.env) {
  if (requestedEnv !== "test") return {};

  if (sourceEnv.ZCODE_DEV_ALLOW_ZCODE_API !== "1") {
    return {
      ZCODE_OFFLINE_PREVIEW: "1",
      ...Object.fromEntries(
        ENDPOINT_ENV_NAMES.map((name) => [name, OFFLINE_PREVIEW_ZCODE_ENDPOINT]),
      ),
    };
  }

  const testOrigin = sourceEnv.ZCODE_TEST_BASE_URL?.trim();
  if (!testOrigin) {
    throw new Error(
      "ZCODE_DEV_ALLOW_ZCODE_API=1 requires an explicit ZCODE_TEST_BASE_URL; refusing to use the default ZCode endpoint.",
    );
  }

  let normalizedTestOrigin;
  try {
    const parsed = new URL(testOrigin);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("unsupported test origin");
    }
    normalizedTestOrigin = parsed.origin;
  } catch {
    throw new Error("ZCODE_TEST_BASE_URL must be a valid HTTP(S) origin.");
  }

  const productionOrigin = normalizeOrigin(
    sourceEnv.ZCODE_PRODUCTION_BASE_URL || "https://zcode.z.ai",
  );
  if (normalizedTestOrigin === productionOrigin) {
    throw new Error("ZCODE_TEST_BASE_URL must not point to the ZCode production endpoint.");
  }

  return {
    ZCODE_OFFLINE_PREVIEW: "0",
    ...Object.fromEntries(ENDPOINT_ENV_NAMES.map((name) => [name, normalizedTestOrigin])),
  };
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
