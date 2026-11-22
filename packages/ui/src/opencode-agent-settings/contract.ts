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
    };export type OpenCodeAgentCliStatus =
  | { status: "available"; version: string; executablePath: string }
  | {
      status: "missing" | "unavailable" | "timed-out";
      diagnostic: string;
      installSupported?: boolean;
    };/** ACP selectors are rendered from the live session response; no ZCode provider fallback exists. */
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
