// ============================================================
// Zod -> provider-neutral JSON Schema for tool contracts
// ============================================================

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { JsonSchema } from "../model/index.js";

const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
]);
export const TOOL_JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

/**
 * Convert a Zod runtime schema into the JSON Schema subset exposed to model
 * providers. Keep all built-in tool schemas on this path so runtime validation
 * and provider-facing function parameters cannot drift.
 */
export function toToolJsonSchema(schema: ZodTypeAny): JsonSchema {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    effectStrategy: "input",
    target: "jsonSchema7",
  }) as JsonSchema;

  normalizeToolJsonSchema(jsonSchema);
  jsonSchema.$schema = TOOL_JSON_SCHEMA_VERSION;
  return jsonSchema;
}

export function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  normalizeSchemaNode(schema);
  return schema;
}

function normalizeSchemaNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeSchemaNode(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const key of STRIPPED_SCHEMA_KEYS) {
    delete value[key];
  }
  // OpenCode Go Responses 的严格工具编译器拒绝 propertyNames；Record 的值约束由 additionalProperties 保留。
  delete value.propertyNames;

  normalizeSchemaMap(value.properties);
  normalizeSchemaMap(value.patternProperties);
  normalizeSchemaMap(value.dependentSchemas);
  normalizeSchemaNode(value.items);
  normalizeSchemaNode(value.prefixItems);
  normalizeSchemaNode(value.additionalProperties);
  normalizeSchemaNode(value.additionalItems);
  normalizeSchemaNode(value.unevaluatedProperties);
  normalizeSchemaNode(value.unevaluatedItems);
  normalizeSchemaNode(value.contains);
  normalizeSchemaNode(value.not);
  normalizeSchemaNode(value.if);
  normalizeSchemaNode(value.then);
  normalizeSchemaNode(value.else);
  normalizeSchemaNode(value.oneOf);
  normalizeSchemaNode(value.anyOf);
  normalizeSchemaNode(value.allOf);

  if (Array.isArray(value.anyOf) && value.oneOf === undefined) {
    value.oneOf = value.anyOf;
    delete value.anyOf;
  }

  if (value.type === undefined) {
    const inferredType = inferSchemaType(value);
    if (inferredType) {
      value.type = inferredType;
    }
  }

  const typeValues = Array.isArray(value.type) ? value.type : [value.type];
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    value.additionalProperties === undefined
  ) {
    value.properties = {};
  }
  if (typeValues.includes("array") && value.items === undefined) {
    value.items = {};
  }
}

function normalizeSchemaMap(value: unknown): void {
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) {
    normalizeSchemaNode(child);
  }
}

function inferSchemaType(schema: Record<string, unknown>): string | undefined {
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    return "object";
  }
  if (schema.items !== undefined || typeof schema.minItems === "number" || typeof schema.maxItems === "number") {
    return "array";
  }
  if (Array.isArray(schema.enum)) {
    return inferTypeFromValues(schema.enum);
  }
  if ("const" in schema) {
    return inferTypeFromValues([schema.const]);
  }
  if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
    return "string";
  }
  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") {
    return "number";
  }
  return undefined;
}

function inferTypeFromValues(values: unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => Number.isInteger(value))) return "integer";
  if (values.every((value) => typeof value === "number")) return "number";
  if (values.every((value) => value === null)) return "null";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
