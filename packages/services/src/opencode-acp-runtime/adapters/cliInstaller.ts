import type {
  IOpenCodeAcpRuntime,
  OpenCodeCliStatus,
  OpenCodeInstallCommandOutcome,
  OpenCodeInstallResult,
} from "../contract.js";
import type { OpenCodeCliResolution, OpenCodeCommandSpec } from "./cliResolver.js";
import { INSTALL_TIMEOUT_MS } from "./childProcessSupport.js";
import { resolveOpenCodeCliReleaseAsset } from "./cliReleaseManifest.js";

interface OpenCodeCliInstallerDependencies {
  resolveCli: (cliPath?: string) => OpenCodeCliResolution | Promise<OpenCodeCliResolution>;
  runVersion: (spec: OpenCodeCommandSpec) => Promise<OpenCodeCliStatus>;
  installOfficialCli: (timeoutMs: number) => Promise<OpenCodeInstallCommandOutcome>;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  linuxLibc?: "glibc" | "musl";
  installTimeoutMs?: number;
}

export function createOpenCodeCliInstaller(
  dependencies: OpenCodeCliInstallerDependencies,
): Pick<IOpenCodeAcpRuntime, "getCliStatus" | "installCli"> {
  const isInstallSupported = () =>
    Boolean(
      resolveOpenCodeCliReleaseAsset({
        platform: dependencies.platform,
        architecture: dependencies.architecture,
        linuxLibc: dependencies.linuxLibc,
      }),
    );

  const describeExistingCli = async (
    resolution: OpenCodeCliResolution,
  ): Promise<OpenCodeInstallResult | undefined> => {
    if (resolution.status === "missing") return undefined;
    if (resolution.status !== "resolved") {
      return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
    }
    const current = await dependencies.runVersion(resolution.spec);
    return current.status === "available"
      ? {
          status: "already-installed",
          version: current.version,
          executablePath: current.executablePath,
        }
      : { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
  };

  const installCli: IOpenCodeAcpRuntime["installCli"] = async ({ cliPath } = {}) => {
    const resolution = await dependencies.resolveCli(cliPath);
    if (cliPath?.trim()) {
      const existing = await describeExistingCli(resolution);
      return (
        existing ?? { status: "failed", diagnostic: "opencode.install-explicit-path-selected" }
      );
    }

    const existing = await describeExistingCli(resolution);
    if (existing) return existing;
    if (!isInstallSupported()) {
      return { status: "failed", diagnostic: "opencode.install-platform-unsupported" };
    }

    // Причина: повторное обнаружение перед загрузкой не даёт гонке заменить CLI, появившийся после проверки Settings.
    const beforeInstall = await describeExistingCli(await dependencies.resolveCli());
    if (beforeInstall) return beforeInstall;
    const outcome = await dependencies.installOfficialCli(
      dependencies.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
    );
    if (!outcome.ok) return { status: "failed", diagnostic: outcome.diagnostic };

    const afterResolution = await dependencies.resolveCli();
    if (afterResolution.status !== "resolved") {
      return { status: "failed", diagnostic: "opencode.install-verification-failed" };
    }
    const after = await dependencies.runVersion(afterResolution.spec);
    if (after.status === "timed-out") {
      return { status: "failed", diagnostic: "opencode.install-timeout" };
    }
    return after.status === "available"
      ? {
          status: "installed",
          version: after.version,
          executablePath: after.executablePath,
        }
      : { status: "failed", diagnostic: "opencode.install-verification-failed" };
  };

  const getCliStatus: IOpenCodeAcpRuntime["getCliStatus"] = async ({ cliPath } = {}) => {
    const resolution = await dependencies.resolveCli(cliPath);
    if (resolution.status !== "resolved") {
      return {
        status: resolution.status === "missing" ? "missing" : "unavailable",
        diagnostic: resolution.diagnostic,
        installSupported: resolution.status === "missing" && isInstallSupported(),
      };
    }
    return await dependencies.runVersion(resolution.spec);
  };

  return { getCliStatus, installCli };
}
