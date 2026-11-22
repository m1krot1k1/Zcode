// ============================================================
// Model Tool Transform Tests
// ============================================================

import { describe, expect, it } from "vitest";
import type { ModelToolContract } from "@zcode/contracts";
import { toAiSdkTools } from "../src/model/index.js";

function createClientToolContract(): ModelToolContract {
  return {
    name: "Read",
    capability: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    outputSchema: { type: "object" },
    readOnly: true,
  };
}

function readToolJsonSchema(toolValue: unknown): Record<string, unknown> {
  return (toolValue as { inputSchema: { jsonSchema: Record<string, unknown> } }).inputSchema
    .jsonSchema;
}

describe("model tool transforms", () => {
  it("keeps local output unions out of provider tool declarations", () => {
    const contract = createClientToolContract();
    contract.outputSchema = {
      anyOf: [{ type: "string" }, { type: "object", properties: { error: { type: "string" } } }],
    };
    const tools = toAiSdkTools([contract]);
    expect(readToolJsonSchema(tools?.Read)).toEqual(contract.inputSchema);
    expect(tools?.Read).not.toHaveProperty("outputSchema");
  });

  it("opts Anthropic client-side tools out of eager input streaming", () => {
    const tools = toAiSdkTools([createClientToolContract()], {
      providerKind: "anthropic",
    });

    expect(tools?.Read).toMatchObject({
      providerOptions: {
        anthropic: {
          eagerInputStreaming: false,
        },
      },
    });
  });

  it("does not add Anthropic tool provider options for non-Anthropic providers", () => {
    const tools = toAiSdkTools([createClientToolContract()], {
      providerKind: "openai",
    });

    expect(
      (tools?.Read as { providerOptions?: unknown } | undefined)?.providerOptions,
    ).toBeUndefined();
  });

  it("hoists Kimi K3 local property refs into root defs without mutating the contract", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: {
        func: {
          type: "object",
          properties: {
            vpc: {
              type: "object",
              properties: { vpcId: { type: "string" } },
              required: ["vpcId"],
            },
            triggers: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          },
        },
        vpc: { $ref: "#/properties/func/properties/vpc" },
        triggers: {
          type: "array",
          items: { $ref: "#/properties/func/properties/triggers/items" },
        },
      },
    };

    const tools = toAiSdkTools([contract], {
      providerKind: "openai-compatible",
      requiresMfjsToolSchema: true,
    });
    const schema = readToolJsonSchema(tools?.Read);

    expect(schema).toMatchObject({
      $defs: {
        zcode_ref_0: {
          type: "object",
          properties: { vpcId: { type: "string" } },
          required: ["vpcId"],
        },
        zcode_ref_1: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      properties: {
        vpc: { $ref: "#/$defs/zcode_ref_0" },
        triggers: {
          items: { $ref: "#/$defs/zcode_ref_1" },
        },
      },
    });
    expect(contract.inputSchema).toMatchObject({
      properties: {
        vpc: { $ref: "#/properties/func/properties/vpc" },
        triggers: {
          items: { $ref: "#/properties/func/properties/triggers/items" },
        },
      },
    });
    expect(contract.inputSchema).not.toHaveProperty("$defs");
  });

  it("keeps local refs and strips propertyNames when MFJS projection is disabled", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: false,
      $defs: {
        Id: { type: "string", propertyNames: { type: "string" } },
      },
      properties: {
        source: {
          type: "object",
          propertyNames: { type: "string" },
          properties: { id: { type: "string" } },
        },
        alias: { $ref: "#/properties/source" },
      },
    };
    const snapshot = structuredClone(contract.inputSchema);

    const tools = toAiSdkTools([contract], {
      providerKind: "openai-compatible",
      requiresMfjsToolSchema: false,
    });
    const sent = readToolJsonSchema(tools?.Read);
    const properties = sent.properties as Record<string, Record<string, unknown>>;
    const defs = sent.$defs as Record<string, Record<string, unknown>>;

    expect(contract.inputSchema).toEqual(snapshot);
    expect(sent).not.toBe(contract.inputSchema);
    expect(properties.alias.$ref).toBe("#/properties/source");
    expect(sent).not.toHaveProperty("propertyNames");
    expect(properties.source).not.toHaveProperty("propertyNames");
    expect(defs.Id).not.toHaveProperty("propertyNames");
    expect(sent.additionalProperties).toBe(false);
    expect(sent).toHaveProperty("$defs");
  });

  it("strips propertyNames on every provider send without mutating the contract", () => {
    const cases: Array<{
      providerKind?:
        | "openai"
        | "anthropic"
        | "openai-compatible"
        | "opencode-sdk"
        | "gateway"
        | "custom";
      requiresMfjsToolSchema?: boolean;
    }> = [
      {},
      { providerKind: "openai" },
      { providerKind: "anthropic" },
      { providerKind: "openai-compatible" },
      { providerKind: "opencode-sdk" },
      { providerKind: "gateway" },
      { providerKind: "custom" },
      { providerKind: "openai", requiresMfjsToolSchema: true },
      { providerKind: "anthropic", requiresMfjsToolSchema: true },
      { providerKind: "openai-compatible", requiresMfjsToolSchema: true },
      { providerKind: "opencode-sdk", requiresMfjsToolSchema: true },
      { providerKind: "gateway", requiresMfjsToolSchema: true },
      { providerKind: "custom", requiresMfjsToolSchema: true },
    ];

    for (const options of cases) {
      const contract = createClientToolContract();
      contract.inputSchema = {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: false,
        properties: {
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            propertyNames: { pattern: "^[A-Z]+$" },
          },
        },
      };
      const snapshot = structuredClone(contract.inputSchema);
      const tools = toAiSdkTools([contract], options);
      const sent = readToolJsonSchema(tools?.Read);

      expect(sent).not.toHaveProperty("propertyNames");
      expect(sent.additionalProperties).toBe(false);
      const env = (sent.properties as Record<string, Record<string, unknown>>).env;
      expect(env).not.toHaveProperty("propertyNames");
      expect(env.additionalProperties).toEqual({ type: "string" });
      expect(contract.inputSchema).toEqual(snapshot);
      expect(sent).not.toBe(contract.inputSchema);
    }
  });

  it("rejects an unresolvable local ref before request execution", () => {
    const contract = createClientToolContract();
    contract.inputSchema = {
      type: "object",
      properties: { alias: { $ref: "#/properties/missing" } },
    };

    expect(() =>
      toAiSdkTools([contract], {
        providerKind: "openai-compatible",
        requiresMfjsToolSchema: true,
      }),
    ).toThrowError(/Read.*#\/properties\/missing/u);
  });
});
