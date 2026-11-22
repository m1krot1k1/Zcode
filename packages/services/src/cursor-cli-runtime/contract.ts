/**
 * Cursor CLI (`cursor-agent`) discovery and model catalog contract.
 *
 * The Host owns process-level facts only: where the binary lives, its version, and the model IDs
 * the CLI reports. Request execution happens in the Agent worker through the ordinary Provider
 * Registry (`api.type: "cursor-cli"`), never through this service.
 */

import { createServiceDescriptor } from "../descriptors.js";
import { ServiceChannels } from "@zcode/shared";

export type CursorCliStatus =
  | { status: "available"; version: string; executablePath: string }
  | {
      status: "missing" | "unavailable" | "timed-out";
      diagnostic: string;
      /** Official install command shown to the user; no managed download is attempted. */
      installCommand: string;
    };

/** Safe model metadata projected from `cursor-agent --list-models` / `cursor-agent models`. */
export interface CursorCliModelDescriptor {
  readonly modelId: string;
  readonly name: string;
  /** `cli` — reported by the installed binary; `baseline` — documented fallback list. */
  readonly source: "cli" | "baseline";
}

/**
 * One-click install runs the official Cursor installer once. The Host re-discovers the binary
 * afterwards; the installer's own exit code is not treated as proof that `cursor-agent` works.
 */
export type CursorCliInstallResult =
  | { status: "installed"; version: string; executablePath: string }
  | { status: "failed"; diagnostic: string; installCommand: string };

/** Read-only Cursor CLI catalog. Authentication is intentionally not queried by this call. */
export type CursorCliModelCatalog =
  | {
      status: "available";
      models: CursorCliModelDescriptor[];
      authentication: "not-checked";
    }
  | { status: "unavailable" | "timed-out"; diagnostic: string };

export interface ICursorCliRuntime {
  /** Runs only `cursor-agent --version`; no process is retained and no prompt is started. */
  getCliStatus(params?: { cliPath?: string }): Promise<CursorCliStatus>;
  /** Runs the CLI's model listing once and normalizes it into the provider catalog shape. */
  listModels(params?: { cliPath?: string }): Promise<CursorCliModelCatalog>;
  /** Installs the CLI via the official installer, then verifies discovery before reporting success. */
  installCli(params?: { cliPath?: string }): Promise<CursorCliInstallResult>;
}

export const ICursorCliRuntime = createServiceDescriptor<ICursorCliRuntime>(
  ServiceChannels.CursorCli,
);
