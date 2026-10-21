import assert from "node:assert/strict";
import test from "node:test";
import {
  createMacReleaseBuildEnvironment,
  parseDeveloperIdIdentities,
  preflightMacReleaseSecurity,
  resolveMacReleaseBuildSettings,
  resolveNotarizationCredentialSet,
  selectDeveloperIdIdentity,
} from "../macos-release-security.mjs";

const developerId = "Developer ID Application: ZCode Dev (ABCDE12345)";
const keychainOutput = `
  1) ${"a".repeat(40)} "${developerId}"
  2) ${"b".repeat(40)} "Apple Development: ZCode Dev (ABCDE12345)"
     2 valid identities found
`;

test("выбирает только действительную Developer ID Application identity", () => {
  assert.deepEqual(parseDeveloperIdIdentities(keychainOutput), [developerId]);
  assert.equal(selectDeveloperIdIdentity(keychainOutput), developerId);
  assert.equal(selectDeveloperIdIdentity(keychainOutput, "ZCode Dev (ABCDE12345)"), developerId);
  assert.throws(
    () => selectDeveloperIdIdentity(keychainOutput, "Apple Development: ZCode Dev (ABCDE12345)"),
    /not a valid Developer ID Application/u,
  );
});

test("запрашивает явный выбор при нескольких Developer ID identities", () => {
  const twoIdentities = `${keychainOutput}\n3) ${"c".repeat(40)} "Developer ID Application: Other (FGHIJ67890)"`;
  assert.throws(() => selectDeveloperIdIdentity(twoIdentities), /Multiple Developer ID/u);
  assert.equal(
    selectDeveloperIdIdentity(twoIdentities, "Developer ID Application: Other (FGHIJ67890)"),
    "Developer ID Application: Other (FGHIJ67890)",
  );
  assert.throws(() => selectDeveloperIdIdentity("0 valid identities found"), /was not found/u);
});

test("принимает по одному из трёх документированных electron-builder v26 credential sets", () => {
  assert.equal(
    resolveNotarizationCredentialSet({
      APPLE_API_KEY: "base64-private-key",
      APPLE_API_KEY_ID: "KEYID12345",
      APPLE_API_ISSUER: "issuer-id",
    }),
    "App Store Connect API key",
  );
  assert.equal(
    resolveNotarizationCredentialSet({
      APPLE_ID: "developer@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "secret-value",
      APPLE_TEAM_ID: "ABCDE12345",
    }),
    "Apple ID",
  );
  assert.equal(
    resolveNotarizationCredentialSet({ APPLE_KEYCHAIN_PROFILE: "zcode-notary" }),
    "Keychain profile",
  );
  assert.equal(
    resolveNotarizationCredentialSet({
      APPLE_KEYCHAIN_PROFILE: "zcode-notary",
      APPLE_KEYCHAIN: "/Users/test/Library/Keychains/notary.keychain-db",
    }),
    "Keychain profile",
  );
});

test("отклоняет неполные или неоднозначные notarization credentials без вывода значений", () => {
  const secret = "do-not-print-this-secret";
  assert.throws(
    () =>
      resolveNotarizationCredentialSet({
        APPLE_ID: "developer@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: secret,
      }),
    (error) => {
      assert.match(error.message, /APPLE_TEAM_ID/u);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  assert.throws(
    () =>
      resolveNotarizationCredentialSet({
        APPLE_KEYCHAIN: "/tmp/notary.keychain-db",
      }),
    /APPLE_KEYCHAIN_PROFILE/u,
  );
  assert.throws(
    () =>
      resolveNotarizationCredentialSet({
        APPLE_ID: "developer@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: secret,
        APPLE_TEAM_ID: "ABCDE12345",
        APPLE_API_KEY: "base64-private-key",
        APPLE_API_KEY_ID: "KEYID12345",
        APPLE_API_ISSUER: "issuer-id",
      }),
    /exactly one/u,
  );
});

test("release preflight verifies local identity and complete notarization set on macOS", async () => {
  const commands = [];
  const result = await preflightMacReleaseSecurity({
    env: {
      APPLE_ID: "developer@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "secret-value",
      APPLE_TEAM_ID: "ABCDE12345",
    },
    platform: "darwin",
    captureCommand: async (command) => {
      commands.push(command);
      return keychainOutput;
    },
  });
  assert.deepEqual(commands, [["security", "find-identity", "-v", "-p", "codesigning"]]);
  assert.deepEqual(result, {
    identity: developerId,
    notarizationCredentialSet: "Apple ID",
  });
  const keychainSelection = [];
  await preflightMacReleaseSecurity({
    env: {
      CSC_KEYCHAIN: "/Users/test/Library/Keychains/release.keychain-db",
      APPLE_KEYCHAIN_PROFILE: "zcode-notary",
    },
    platform: "darwin",
    captureCommand: async (command) => {
      keychainSelection.push(command);
      return keychainOutput;
    },
  });
  assert.deepEqual(keychainSelection[0].slice(-1), [
    "/Users/test/Library/Keychains/release.keychain-db",
  ]);
  await assert.rejects(
    preflightMacReleaseSecurity({
      env: {},
      platform: "win32",
      captureCommand: async () => keychainOutput,
    }),
    /must run on macOS/u,
  );
});

test("обычные сборки не включают Apple signing или notarization", () => {
  assert.deepEqual(resolveMacReleaseBuildSettings({}), {
    identity: null,
    signingEnabled: false,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
  });
  assert.deepEqual(resolveMacReleaseBuildSettings({ CSC_NAME: developerId }), {
    identity: null,
    signingEnabled: false,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
  });
});

test("release config включает force signing, hardened runtime и встроенную notarization", () => {
  assert.deepEqual(
    resolveMacReleaseBuildSettings({
      ZCODE_ENABLE_MAC_SIGN: "1",
      ZCODE_ENABLE_MAC_NOTARIZE: "1",
      APPLE_SIGNING_IDENTITY: developerId,
    }),
    {
      identity: "ZCode Dev (ABCDE12345)",
      signingEnabled: true,
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
    },
  );
  assert.throws(
    () => resolveMacReleaseBuildSettings({ ZCODE_ENABLE_MAC_NOTARIZE: "1" }),
    /requires ZCODE_ENABLE_MAC_SIGN/u,
  );
  assert.throws(
    () => resolveMacReleaseBuildSettings({ ZCODE_ENABLE_MAC_SIGN: "1" }),
    /requires a validated/u,
  );
});

test("release build получает только флаги и identity; Apple secrets наследуются отдельно", () => {
  assert.deepEqual(createMacReleaseBuildEnvironment(developerId), {
    ZCODE_ENABLE_MAC_SIGN: "1",
    ZCODE_ENABLE_MAC_NOTARIZE: "1",
    APPLE_SIGNING_IDENTITY: developerId,
  });
  assert.throws(() => createMacReleaseBuildEnvironment("not-a-developer-id"), /identity/u);
});
