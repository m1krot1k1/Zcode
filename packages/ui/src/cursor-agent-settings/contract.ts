import { groupCursorModels } from "@zcode/provider";

/**
 * Renderer-side Cursor CLI facts.
 *
 * Копия wire-контракта Host-а, объявленная локально: UI-слой не импортирует Service/Runtime
 * типы. Панель берёт данные из `useServices().cursorCliRuntime` и структурно совместима с этими
 * типами; при расхождении Host-контракт остаётся источником истины, а компилятор ловит дрейф на
 * месте использования.
 */

/** Stable manifest id shared by the module descriptor and settings wiring. */
export const CURSOR_AGENT_SETTINGS_MODULE_ID = "cursor-agent-settings";

/** Host-reported CLI discovery state; the renderer never spawns the binary itself. */
export type CursorAgentCliStatus =
  | { status: "available"; version: string; executablePath: string }
  | {
      status: "missing" | "unavailable" | "timed-out";
      diagnostic: string;
      /** Official install command shown to the user (also used by the one-click installer). */
      installCommand: string;
    };

/** Safe model metadata projected from `cursor-agent --list-models` / `cursor-agent models`. */
export interface CursorAgentModelDescriptor {
  readonly modelId: string;
  readonly name: string;
  /** `cli` — reported by the installed binary; `baseline` — documented fallback list. */
  readonly source: "cli" | "baseline";
}

/** Result of the one-click official installer; success requires re-discovery of the binary. */
export type CursorAgentCliInstallResult =
  | { status: "installed"; version: string; executablePath: string }
  | { status: "failed"; diagnostic: string; installCommand: string };

/** Read-only catalog; authentication is deliberately not queried by this call. */
export type CursorAgentModelCatalog =
  | {
      status: "available";
      models: CursorAgentModelDescriptor[];
      authentication: "not-checked";
    }
  | { status: "unavailable" | "timed-out"; diagnostic: string };

export interface CursorAgentModelSummary {
  /** Model ids in the order the Host reported them. */
  readonly modelIds: string[];
  /** Human-readable names, falling back to the model id. */
  readonly names: string[];
  readonly count: number;
  /** True when the Host filled the list from the documented baseline set. */
  readonly includesBaseline: boolean;
}

/**
 * Projects a catalog into render-ready facts. Returns null for non-available catalogs so the
 * panel can show its fixed diagnostic instead of inventing model entries.
 */
export function summarizeCursorModels(
  catalog: CursorAgentModelCatalog | undefined,
): CursorAgentModelSummary | null {
  if (!catalog || catalog.status !== "available") return null;
  const grouped = groupCursorModels(catalog.models);
  return {
    modelIds: grouped.map((model) => model.modelId),
    names: grouped.map((model) => model.name),
    count: grouped.length,
    includesBaseline: catalog.models.some((model) => model.source === "baseline"),
  };
}

/** A missing/unavailable status still carries the official install command to show. */
export function getCursorInstallCommand(status: CursorAgentCliStatus | undefined): string | null {
  if (!status || status.status === "available") return null;
  const command = status.installCommand?.trim();
  return command && command.length > 0 ? command : null;
}

/** Host channel absence is distinct from a discovered-but-broken CLI. */
export function isCursorHostUnavailable(status: CursorAgentCliStatus | undefined): boolean {
  return status?.status === "unavailable" && status.diagnostic === "cursor.host-unavailable";
}
