import type { JsonSchema } from "@zcode/contracts";
import {
  MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
  type RepairStage,
} from "./contract.js";
import { repairJsonStringDeterministic } from "./json-repair.js";

const KNOWN_FIELD_ALIASES: Readonly<Record<string, string>> = {
  filePath: "file_path",
  filepath: "file_path",
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
  patchText: "patch_text",
  patch: "patch_text",
  runInBackground: "run_in_background",
  subagentType: "subagent_type",
  writePaths: "write_paths",
};

export interface SchemaCoercionResult {
  readonly value: unknown;
  readonly appliedStages: RepairStage[];
}

export function coerceInputBySchema(
  rawValue: unknown,
  schema: JsonSchema,
): SchemaCoercionResult {
  const appliedStages: RepairStage[] = [];
  const markStage = (stage: RepairStage) => {
    if (!appliedStages.includes(stage)) {
      appliedStages.push(stage);
    }
  };

  let current = rawValue;
  if (isPlainRecord(current)) {
    const unwrapped = unwrapNestedArgumentsEnvelope(current, schema);
    if (unwrapped.changed) {
      current = unwrapped.value;
      markStage("unwrap_nested_arguments_key");
    }
  }

  const coerced = coerceNode(current, schema, markStage);
  return {
    value: coerced,
    appliedStages,
  };
}

function unwrapNestedArgumentsEnvelope(
  record: Record<string, unknown>,
  schema: JsonSchema,
): { value: unknown; changed: boolean } {
  const schemaProperties = isPlainRecord(schema.properties) ? schema.properties : undefined;
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    return { value: record, changed: false };
  }
  const soleKey = keys[0]!;
  if (soleKey !== "arguments" && soleKey !== "input" && soleKey !== "parameters") {
    return { value: record, changed: false };
  }
  if (schemaProperties && Object.prototype.hasOwnProperty.call(schemaProperties, soleKey)) {
    return { value: record, changed: false };
  }
  const inner = record[soleKey];
  if (typeof inner === "string") {
    const parsed = repairJsonStringDeterministic(inner);
    if (parsed.ok && isPlainRecord(parsed.value)) {
      return { value: parsed.value, changed: true };
    }
  }
  if (isPlainRecord(inner)) {
    return { value: inner, changed: true };
  }
  return { value: record, changed: false };
}

function coerceNode(
  value: unknown,
  schema: unknown,
  markStage: (stage: RepairStage) => void,
): unknown {
  if (!isPlainRecord(schema)) {
    return value;
  }

  const expectedTypes = readSchemaTypes(schema);

  if (typeof value === "string") {
    if (expectedTypes.has("boolean") && !expectedTypes.has("string")) {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "false") {
        markStage("coerce_scalar_types_by_schema");
        return normalized === "true";
      }
    }

    if (
      (expectedTypes.has("number") || expectedTypes.has("integer")) &&
      !expectedTypes.has("string")
    ) {
      const trimmed = value.trim();
      if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
        const numeric = Number(trimmed);
        if (
          Number.isFinite(numeric) &&
          (!expectedTypes.has("integer") || expectedTypes.has("number") || Number.isInteger(numeric))
        ) {
          markStage("coerce_scalar_types_by_schema");
          return numeric;
        }
      }
    }

    if (
      (expectedTypes.has("array") || expectedTypes.has("object")) &&
      !expectedTypes.has("string")
    ) {
      const repaired = repairJsonStringDeterministic(value);
      if (repaired.ok) {
        if (
          (expectedTypes.has("array") && Array.isArray(repaired.value)) ||
          (expectedTypes.has("object") && isPlainRecord(repaired.value))
        ) {
          for (const stage of repaired.appliedStages) {
            markStage(stage);
          }
          markStage("coerce_scalar_types_by_schema");
          return coerceNode(repaired.value, schema, markStage);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && isPlainRecord(itemSchema)) {
      return value.map((item) => coerceNode(item, itemSchema, markStage));
    }
    return value;
  }

  if (isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : undefined;
    let working: Record<string, unknown> = {};

    // 1. Обрезка случайных пробелов вокруг имён параметров
    for (const [rawKey, fieldVal] of Object.entries(value)) {
      const trimmedKey = rawKey.trim();
      if (trimmedKey !== rawKey && trimmedKey.length > 0 && !(trimmedKey in value)) {
        working[trimmedKey] = fieldVal;
        markStage("trim_parameter_keys");
      } else {
        working[rawKey] = fieldVal;
      }
    }

    // 2. Безопасный алиасинг известных полей (только если схема ждёт каноническое имя)
    if (properties) {
      const aliased: Record<string, unknown> = {};
      for (const [key, fieldVal] of Object.entries(working)) {
        const canonical = KNOWN_FIELD_ALIASES[key];
        if (
          canonical &&
          !(key in properties) &&
          canonical in properties &&
          !(canonical in working) &&
          !(canonical in aliased)
        ) {
          aliased[canonical] = fieldVal;
          markStage("alias_known_field_names");
        } else {
          aliased[key] = fieldVal;
        }
      }
      working = aliased;
    }

    // 3. Рекурсивная коэрция дочерних полей
    if (properties) {
      const nextRecord: Record<string, unknown> = {};
      for (const [key, fieldVal] of Object.entries(working)) {
        const propSchema = properties[key];
        nextRecord[key] = propSchema ? coerceNode(fieldVal, propSchema, markStage) : fieldVal;
      }
      return nextRecord;
    }

    return working;
  }

  return value;
}

function readSchemaTypes(schema: Record<string, unknown>): Set<string> {
  const types = new Set<string>();
  if (typeof schema.type === "string") {
    types.add(schema.type);
  } else if (Array.isArray(schema.type)) {
    for (const item of schema.type) {
      if (typeof item === "string") types.add(item);
    }
  }
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const branches = schema[unionKey];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (isPlainRecord(branch)) {
          for (const branchType of readSchemaTypes(branch)) {
            types.add(branchType);
          }
        }
      }
    }
  }
  return types;
}

export function buildSchemaDiffDiagnosticFeedback(params: {
  toolName: string;
  receivedInput: unknown;
  inputJsonSchema: JsonSchema;
  validationErrors: readonly string[];
  consecutiveFailureCount?: number;
}): string {
  const properties = isPlainRecord(params.inputJsonSchema.properties)
    ? params.inputJsonSchema.properties
    : {};
  const requiredList = Array.isArray(params.inputJsonSchema.required)
    ? params.inputJsonSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  const requiredSet = new Set(requiredList);
  const receivedRecord = isPlainRecord(params.receivedInput) ? params.receivedInput : undefined;
  const receivedKeys = receivedRecord ? Object.keys(receivedRecord) : [];

  const missingRequired = requiredList.filter(
    (key) => !receivedRecord || receivedRecord[key] === undefined,
  );
  const unexpectedKeys =
    params.inputJsonSchema.additionalProperties === false && Object.keys(properties).length > 0
      ? receivedKeys.filter((key) => !(key in properties))
      : [];

  const fieldShapeLines = Object.entries(properties)
    .slice(0, 16)
    .map(([key, propSchema]) => {
      const propTypes = isPlainRecord(propSchema)
        ? [...readSchemaTypes(propSchema)].join(" | ") || "unknown"
        : "unknown";
      const marker = requiredSet.has(key) ? "required" : "optional";
      const actualDesc =
        receivedRecord && key in receivedRecord ? describeValueType(receivedRecord[key]) : "missing";
      return `  - ${key}: ${propTypes} (${marker}) [received: ${actualDesc}]`;
    });

  const retryCount = params.consecutiveFailureCount ?? 1;
  const retryGuardLines =
    retryCount >= MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES
      ? [
          `RETRY GUARD TRIPPED (${retryCount}/${MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES} consecutive schema failures on "${params.toolName}"):`,
          `STOP retrying "${params.toolName}" with the same malformed payload. Inspect required fields carefully or choose an alternative approach.`,
        ]
      : [
          `Retry budget remaining for "${params.toolName}": ${Math.max(0, MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES - retryCount)} attempt(s).`,
        ];

  const sections = [
    `<tool_use_error code="TOOL_INPUT_SCHEMA_MISMATCH">`,
    `Tool "${params.toolName}" input failed schema validation after automatic self-repair.`,
    ...(missingRequired.length > 0
      ? [`Missing required fields: ${missingRequired.join(", ")}`]
      : []),
    ...(unexpectedKeys.length > 0 ? [`Unexpected fields: ${unexpectedKeys.join(", ")}`] : []),
    ...(params.validationErrors.length > 0
      ? [`Validation issues:\n${params.validationErrors.slice(0, 8).map((err) => `  * ${err}`).join("\n")}`]
      : []),
    ...(fieldShapeLines.length > 0 ? [`Expected schema diff:\n${fieldShapeLines.join("\n")}`] : []),
    ...retryGuardLines,
    `</tool_use_error>`,
  ];

  return sections.join("\n");
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
