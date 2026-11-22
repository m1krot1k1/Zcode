import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeToolJsonSchema, toToolJsonSchema } from "../src/tools/json-schema.js";

describe("provider-facing tool JSON Schema", () => {
  it("keeps record values without the unsupported propertyNames keyword", () => {
    const schema = toToolJsonSchema(z.object({ env: z.record(z.string()) }));
    const env = schema.properties?.env as Record<string, unknown>;

    expect(env.additionalProperties).toEqual({ type: "string" });
    expect(env).not.toHaveProperty("propertyNames");
  });

  it("removes propertyNames from external nested tool schemas", () => {
    const schema = normalizeToolJsonSchema({
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: false,
      properties: {
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          propertyNames: { pattern: "^[A-Z]+$" },
          patternProperties: {
            "^X-": {
              type: "object",
              additionalProperties: { type: "number" },
              propertyNames: { type: "string" },
            },
          },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: { type: "boolean" },
            propertyNames: { minLength: 1 },
          },
        },
      },
      oneOf: [
        {
          type: "object",
          additionalProperties: { type: "string" },
          propertyNames: { type: "string" },
        },
      ],
    });

    expect(schema).not.toHaveProperty("propertyNames");
    expect(schema.additionalProperties).toBe(false);
    const env = schema.properties?.env as Record<string, unknown>;
    expect(env.additionalProperties).toEqual({ type: "string" });
    expect(env).not.toHaveProperty("propertyNames");
    const patterned = (env.patternProperties as Record<string, Record<string, unknown>>)["^X-"];
    expect(patterned?.additionalProperties).toEqual({ type: "number" });
    expect(patterned).not.toHaveProperty("propertyNames");
    const rows = schema.properties?.rows as { items: Record<string, unknown> };
    expect(rows.items.additionalProperties).toEqual({ type: "boolean" });
    expect(rows.items).not.toHaveProperty("propertyNames");
    const branch = (schema.oneOf as Record<string, unknown>[])[0];
    expect(branch?.additionalProperties).toEqual({ type: "string" });
    expect(branch).not.toHaveProperty("propertyNames");
  });
});
