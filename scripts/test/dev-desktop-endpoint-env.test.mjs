import assert from "node:assert/strict";
import test from "node:test";
import { OFFLINE_PREVIEW_ZCODE_ENDPOINT } from "../preview-release-contract.mjs";
import { resolveDevDesktopEndpointEnv } from "../dev-desktop-endpoint-env.mjs";

const endpointNames = [
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "VITE_ZCODE_BASE_URL",
  "VITE_ZCODE_ENDPOINT_ORIGIN",
];

test("test Desktop launch pins every ZCode endpoint alias to the offline loopback sink", () => {
  const env = resolveDevDesktopEndpointEnv("test", {
    ZCODE_BASE_URL: "https://zcode.z.ai",
    ZCODE_TEST_BASE_URL: "https://zcode.z.ai",
    ZCODE_OFFLINE_PREVIEW: "0",
  });

  assert.equal(env.ZCODE_OFFLINE_PREVIEW, "1");
  for (const name of endpointNames) {
    assert.equal(env[name], OFFLINE_PREVIEW_ZCODE_ENDPOINT);
  }
});

test("remote test endpoints require explicit opt-in and a valid non-production origin", () => {
  assert.throws(
    () => resolveDevDesktopEndpointEnv("test", { ZCODE_DEV_ALLOW_ZCODE_API: "1" }),
    /requires an explicit ZCODE_TEST_BASE_URL/u,
  );
  assert.throws(
    () =>
      resolveDevDesktopEndpointEnv("test", {
        ZCODE_DEV_ALLOW_ZCODE_API: "1",
        ZCODE_TEST_BASE_URL: "https://zcode.z.ai",
      }),
    /must not point to the ZCode production endpoint/u,
  );
  assert.throws(
    () =>
      resolveDevDesktopEndpointEnv("test", {
        ZCODE_DEV_ALLOW_ZCODE_API: "1",
        ZCODE_TEST_BASE_URL: "https://user:secret@test.example.com/path",
      }),
    /valid HTTP\(S\) origin/u,
  );
});

test("explicit remote test mode pins all aliases to the provided origin", () => {
  const env = resolveDevDesktopEndpointEnv("test", {
    ZCODE_DEV_ALLOW_ZCODE_API: "1",
    ZCODE_TEST_BASE_URL: "https://test.example.com/api/v1/",
    ZCODE_PRODUCTION_BASE_URL: "https://production.example.com",
    ZCODE_OFFLINE_PREVIEW: "1",
  });

  assert.equal(env.ZCODE_OFFLINE_PREVIEW, "0");
  for (const name of endpointNames) {
    assert.equal(env[name], "https://test.example.com");
  }
});

test("production Desktop launch does not receive test isolation overrides", () => {
  assert.deepEqual(resolveDevDesktopEndpointEnv("production", {}), {});
});
