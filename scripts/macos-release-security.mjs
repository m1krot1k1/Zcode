const NOTARIZATION_CREDENTIAL_SETS = [
  {
    name: "App Store Connect API key",
    fields: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  {
    name: "Apple ID",
    fields: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  },
  {
    name: "Keychain profile",
    fields: ["APPLE_KEYCHAIN_PROFILE"],
    optionalFields: ["APPLE_KEYCHAIN"],
  },
];

function hasValue(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function normalizeIdentityName(value) {
  return value.trim().replace(/^Developer ID Application:\s*/u, "");
}

export function parseDeveloperIdIdentities(keychainOutput) {
  const identities = new Set();
  const pattern = /^\s*\d+\)\s+[a-f0-9]{40,64}\s+"([^"]+)"\s*$/gimu;
  for (const match of String(keychainOutput).matchAll(pattern)) {
    if (match[1].startsWith("Developer ID Application:")) identities.add(match[1]);
  }
  return [...identities];
}

export function selectDeveloperIdIdentity(keychainOutput, configuredIdentity = "") {
  const identities = parseDeveloperIdIdentities(keychainOutput);
  const configured = typeof configuredIdentity === "string" ? configuredIdentity.trim() : "";
  if (configured) {
    const normalized = normalizeIdentityName(configured);
    const match = identities.find((identity) => normalizeIdentityName(identity) === normalized);
    if (!match) {
      throw new Error(
        "Configured macOS signing identity is not a valid Developer ID Application identity in the keychain.",
      );
    }
    return match;
  }
  if (identities.length !== 1) {
    throw new Error(
      identities.length === 0
        ? "A valid Developer ID Application signing identity was not found in the keychain."
        : "Multiple Developer ID Application identities were found; set APPLE_SIGNING_IDENTITY or CSC_NAME.",
    );
  }
  return identities[0];
}

export function resolveNotarizationCredentialSet(env) {
  const complete = [];
  for (const candidate of NOTARIZATION_CREDENTIAL_SETS) {
    const names = [...candidate.fields, ...(candidate.optionalFields ?? [])];
    const supplied = names.filter((name) => hasValue(env, name));
    const missing = candidate.fields.filter((name) => !hasValue(env, name));
    if (supplied.length > 0 && missing.length > 0) {
      throw new Error(
        `Incomplete ${candidate.name} notarization credentials; missing environment variables: ${missing.join(", ")}.`,
      );
    }
    if (missing.length === 0) complete.push(candidate.name);
  }
  if (complete.length !== 1) {
    throw new Error(
      complete.length === 0
        ? "Set exactly one complete electron-builder notarization credential set: App Store Connect API key, Apple ID, or Keychain profile."
        : "Set exactly one electron-builder notarization credential set; multiple complete sets are configured.",
    );
  }
  return complete[0];
}

export async function preflightMacReleaseSecurity({
  env = process.env,
  platform = process.platform,
  captureCommand,
}) {
  if (platform !== "darwin") {
    throw new Error("macOS release signing and notarization preflight must run on macOS.");
  }
  if (typeof captureCommand !== "function") {
    throw new Error("macOS release preflight requires a command capture function.");
  }
  const identityCommand = ["security", "find-identity", "-v", "-p", "codesigning"];
  if (hasValue(env, "CSC_KEYCHAIN")) identityCommand.push(env.CSC_KEYCHAIN.trim());
  const keychainOutput = await captureCommand(identityCommand);
  const configuredIdentity = env.APPLE_SIGNING_IDENTITY || env.CSC_NAME || "";
  const identity = selectDeveloperIdIdentity(keychainOutput, configuredIdentity);
  const notarizationCredentialSet = resolveNotarizationCredentialSet(env);
  return { identity, notarizationCredentialSet };
}

export function createMacReleaseBuildEnvironment(identity) {
  if (typeof identity !== "string" || !identity.startsWith("Developer ID Application:")) {
    throw new Error(
      "A validated Developer ID Application identity is required for a release build.",
    );
  }
  return {
    ZCODE_ENABLE_MAC_SIGN: "1",
    ZCODE_ENABLE_MAC_NOTARIZE: "1",
    APPLE_SIGNING_IDENTITY: identity,
  };
}

export function resolveMacReleaseBuildSettings(env = process.env) {
  const signingRequested = env.ZCODE_ENABLE_MAC_SIGN === "1";
  const notarizationRequested = env.ZCODE_ENABLE_MAC_NOTARIZE === "1";
  const configuredIdentity = env.APPLE_SIGNING_IDENTITY || env.CSC_NAME || "";
  const identity = configuredIdentity ? normalizeIdentityName(configuredIdentity) : null;

  if (notarizationRequested && !signingRequested) {
    throw new Error("ZCODE_ENABLE_MAC_NOTARIZE requires ZCODE_ENABLE_MAC_SIGN=1.");
  }
  if (signingRequested && !identity) {
    throw new Error(
      "ZCODE_ENABLE_MAC_SIGN=1 requires a validated APPLE_SIGNING_IDENTITY or CSC_NAME.",
    );
  }

  return {
    identity: signingRequested ? identity : null,
    signingEnabled: signingRequested,
    forceCodeSigning: signingRequested,
    hardenedRuntime: signingRequested,
    notarize: notarizationRequested,
  };
}
