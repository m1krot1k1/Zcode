interface OpenCodeAgentSelectValue {
  value: string;
  name: string;
  description?: string | null;
}

interface OpenCodeAgentSelectGroup {
  group: string;
  name: string;
  options: OpenCodeAgentSelectValue[];
}

export type OpenCodeAgentConfigOption =
  | {
      id: string;
      name: string;
      category?: string | null;
      description?: string | null;
      type: "select";
      currentValue: string;
      options: Array<OpenCodeAgentSelectValue | OpenCodeAgentSelectGroup>;
    }
  | {
      id: string;
      name: string;
      category?: string | null;
      description?: string | null;
      type: "boolean";
      currentValue: boolean;
    };

interface OpenCodeAgentSession {
  sessionId: string;
  cwd: string;
  configOptions: OpenCodeAgentConfigOption[];
}

export type OpenCodeAgentCliStatus =
  | { status: "available"; version: string; executablePath: string }
  | {
      status: "missing" | "unavailable" | "timed-out";
      diagnostic: string;
      installSupported?: boolean;
    };

export type OpenCodeAgentModelCatalog =
  | { status: "available"; models: string[]; authentication: "not-checked" }
  | { status: "unavailable" | "timed-out"; diagnostic: string };

type OpenCodeAgentPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface OpenCodeAgentPermissionRequest {
  requestId: string;
  sessionId: string;
  toolTitle: string;
  toolKind?: string;
  inputSummary?: string;
  options: Array<{
    optionId: string;
    kind: OpenCodeAgentPermissionOptionKind;
    name: string;
  }>;
}

type OpenCodeAgentPermissionEvent =
  | { type: "requested"; request: OpenCodeAgentPermissionRequest }
  | { type: "resolved"; requestId: string; sessionId: string };

/** ACP selectors are rendered from the live session response; no ZCode provider fallback exists. */
export function getOpenCodeSelectValues(option: OpenCodeAgentConfigOption): Array<{
  value: string;
  name: string;
  description?: string | null;
}> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name, description: entry.description }]
      : entry.options.map((grouped) => ({
          value: grouped.value,
          name: `${entry.name}: ${grouped.name}`,
          description: grouped.description,
        })),
  );
}

export function findOpenCodeConfigOption(
  options: OpenCodeAgentConfigOption[],
  category: string,
): OpenCodeAgentConfigOption | undefined {
  return options.find(
    (option) =>
      option.category === category &&
      option.type === "select" &&
      getOpenCodeSelectValues(option).length > 0,
  );
}
