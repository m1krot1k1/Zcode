import type { IOpenCodeAcpRuntime, OpenCodeCliStatus, OpenCodeInstallResult } from "../contract.js";
import type { OpenCodeCliResolution, OpenCodeCommandSpec } from "./cliResolver.js";
import { INSTALL_TIMEOUT_MS } from "./childProcessSupport.js";

export interface OpenCodeCliInstallerDependencies {
  resolveCli: (cliPath?: string) => OpenCodeCliResolution | Promise<OpenCodeCliResolution>;
  resolveWinget: () => Promise<string | undefined>;
  runVersion: (spec: OpenCodeCommandSpec) => Promise<OpenCodeCliStatus>;
  installPosixCli: (timeoutMs: number) => Promise<boolean>;
  resolvePosixInstallerCommands: () => Promise<{ bash: string; curl: string } | undefined>;
  installWingetPackage: (wingetPath: string, timeoutMs: number) => Promise<boolean>;
  platform: NodeJS.Platform;
  installTimeoutMs?: number;
}

export function createOpenCodeCliInstaller(
  dependencies: OpenCodeCliInstallerDependencies,
): Pick<IOpenCodeAcpRuntime, "getCliStatus" | "installCli"> {
  const checkCliBeforeInstall = async (): Promise<OpenCodeInstallResult | undefined> => {
    const current = await dependencies.resolveCli();
    if (current.status === "missing") return undefined;
    if (current.status !== "resolved") {
      return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
    }
    const version = await dependencies.runVersion(current.spec);
    if (version.status === "available") {
      return {
        status: "already-installed",
        version: version.version,
        executablePath: version.executablePath,
      };
    }
    return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
  };

  const installCli = async ({
    cliPath,
  }: { cliPath?: string } = {}): Promise<OpenCodeInstallResult> => {
    const resolution = await dependencies.resolveCli(cliPath);
    const platform = dependencies.platform;
    if (cliPath?.trim()) {
      if (resolution.status === "resolved") {
        const current = await dependencies.runVersion(resolution.spec);
        if (current.status === "available") {
          return {
            status: "already-installed",
            version: current.version,
            executablePath: current.executablePath,
          };
        }
      }
      return { status: "failed", diagnostic: "opencode.install-explicit-path-selected" };
    }
    if (platform === "win32") {
      if (resolution.status === "resolved") {
        const current = await dependencies.runVersion(resolution.spec);
        if (current.status === "available") {
          return {
            status: "already-installed",
            version: current.version,
            executablePath: current.executablePath,
          };
        }
      }
      if (resolution.status !== "missing") {
        return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
      }
      const wingetPath = await dependencies.resolveWinget();
      if (!wingetPath) {
        return { status: "failed", diagnostic: "opencode.install-platform-unsupported" };
      }
      const cliBeforeInstall = await checkCliBeforeInstall();
      if (cliBeforeInstall) return cliBeforeInstall;
      const installed = await dependencies.installWingetPackage(
        wingetPath,
        dependencies.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      );
      if (!installed) return { status: "failed", diagnostic: "opencode.install-failed" };
      const afterResolution = await dependencies.resolveCli();
      if (afterResolution.status !== "resolved") {
        return { status: "failed", diagnostic: "opencode.install-verification-failed" };
      }
      const after = await dependencies.runVersion(afterResolution.spec);
      return after.status === "available"
        ? {
            status: "installed",
            version: after.version,
            executablePath: after.executablePath,
          }
        : { status: "failed", diagnostic: "opencode.install-verification-failed" };
    }

    // Причина: POSIX-установка ранее требовала resolved CLI и отказывала при его отсутствии, хотя UI показывал Install.
    if (resolution.status === "resolved") {
      const before = await dependencies.runVersion(resolution.spec);
      if (before.status === "available") {
        return {
          status: "already-installed",
          version: before.version,
          executablePath: before.executablePath,
        };
      }
      if (before.status !== "missing") {
        return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
      }
    } else if (resolution.status !== "missing" || !resolution.installSupported) {
      return { status: "failed", diagnostic: "opencode.install-requires-missing-cli" };
    }
    if (!(await dependencies.resolvePosixInstallerCommands())) {
      return { status: "failed", diagnostic: "opencode.install-platform-unsupported" };
    }
    const cliBeforeInstall = await checkCliBeforeInstall();
    if (cliBeforeInstall) return cliBeforeInstall;
    const installed = await dependencies.installPosixCli(
      dependencies.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
    );
    if (!installed) return { status: "failed", diagnostic: "opencode.install-failed" };
    const afterResolution = await dependencies.resolveCli();
    if (afterResolution.status !== "resolved") {
      return { status: "failed", diagnostic: "opencode.install-verification-failed" };
    }
    const after = await dependencies.runVersion(afterResolution.spec);
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
      const installSupported =
        resolution.status === "missing" &&
        (dependencies.platform === "win32"
          ? Boolean(await dependencies.resolveWinget())
          : (dependencies.platform === "darwin" || dependencies.platform === "linux") &&
            resolution.installSupported &&
            Boolean(await dependencies.resolvePosixInstallerCommands()));
      return {
        status: resolution.status === "missing" ? "missing" : "unavailable",
        diagnostic: resolution.diagnostic,
        installSupported,
      };
    }
    return await dependencies.runVersion(resolution.spec);
  };

  return { getCliStatus, installCli };
}
