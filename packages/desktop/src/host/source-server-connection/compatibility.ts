import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  evaluateSourceServerCompatibility,
  type CompatibilityManifest,
  type SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import type { CompatibilityStateFields } from "./types.js";

export function buildCompatibilityState(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): CompatibilityStateFields {
  const result = evaluateSourceServerCompatibility(controller, server);
  if (!result.compatible && result.upgradeTarget) {
    return {
      updateAvailability: "required",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.upgradeTarget,
    };
  }
  if (result.updateAvailable) {
    return {
      updateAvailability: "available",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.newerEndpoint === "controller" ? "server" : "controller",
    };
  }
  return {
    updateAvailability: "none",
    currentVersion: server.productVersion,
    availableVersion: server.productVersion,
    minimumVersion: result.requiredMinimumVersion,
  };
}

export function preserveCompatibilityState(
  snapshot: SourceServerConnectionStateSnapshot,
): CompatibilityStateFields {
  return {
    ...(snapshot.updateAvailability ? { updateAvailability: snapshot.updateAvailability } : {}),
    ...(snapshot.currentVersion ? { currentVersion: snapshot.currentVersion } : {}),
    ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
    ...(snapshot.minimumVersion ? { minimumVersion: snapshot.minimumVersion } : {}),
    ...(snapshot.upgradeTarget ? { upgradeTarget: snapshot.upgradeTarget } : {}),
  };
}

export function readErrorRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) {
    return undefined;
  }
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

export function isAutomaticRecoveryUserActionCode(code: unknown): boolean {
  return (
    code === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE
  );
}
