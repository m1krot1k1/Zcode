import { describe, expect, it } from "vitest";

import {
  zcodeProtocolMethods,
  zcodeSessionEventSchema,
  zcodeSessionEventTypeSchema,
  zcodeUncensoredGetConfigParamsSchema,
  zcodeUncensoredGetConfigResultSchema,
  zcodeUncensoredSettingsStatusSchema,
  zcodeUncensoredSettingsWriteSchema,
} from "../src/zcode-protocol/index.js";
import { subagentRowSchema } from "../src/zcode-protocol-v4/index.js";

const modelRefusalPayload = {
  taskId: "session-1",
  itemIndex: 3,
  itemText: "Add the missing regression test",
  reason: "content-filter",
};

const modelRefusalEnvelope = {
  eventId: "event-1",
  sessionId: "session-1",
  seq: 1,
  timestamp: 1_700_000_000_000,
  type: "model.refusal" as const,
};

const providerConfig = {
  id: "provider-a",
  name: "Provider A",
  apiUrl: "https://example.test/v1/chat/completions",
  apiKey: "secret",
  models: [{ id: "model-a", enabled: true }],
};

const providerStatus = {
  id: "provider-a",
  name: "Provider A",
  apiUrl: "https://example.test/v1/chat/completions",
  apiKeyConfigured: true,
  models: [{ id: "model-a", enabled: true }],
};

const providerWrite = {
  id: "provider-a",
  name: "Provider A",
  apiUrl: "https://example.test/v1/chat/completions",
  apiKey: "secret",
  models: [{ id: "model-a", enabled: true }],
};

function parseRefusal(payload: Record<string, unknown>) {
  return zcodeSessionEventSchema.parse({ ...modelRefusalEnvelope, payload });
}

function subagentRow(overrides: Record<string, unknown> = {}) {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "subagent",
    subagentType: "uncensored-takeover",
    status: "running",
    summaryText: "Uncensored takeover",
    ...overrides,
  };
}

describe("uncensored/getConfig protocol", () => {
  it("declares the exact method name", () => {
    expect(zcodeProtocolMethods.uncensoredGetConfig).toBe("uncensored/getConfig");
  });

  it("accepts a strict workspace-addressed request with and without identity", () => {
    expect(
      zcodeUncensoredGetConfigParamsSchema.parse({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host:/repo",
      }),
    ).toEqual({ workspacePath: "/repo", workspaceIdentity: "remote:ssh:host:/repo" });
    expect(zcodeUncensoredGetConfigParamsSchema.parse({ workspacePath: "/repo" })).toEqual({
      workspacePath: "/repo",
    });
  });

  it("rejects malformed requests and undeclared fields", () => {
    expect(() => zcodeUncensoredGetConfigParamsSchema.parse({})).toThrow();
    expect(() => zcodeUncensoredGetConfigParamsSchema.parse({ workspacePath: "" })).toThrow();
    expect(() =>
      zcodeUncensoredGetConfigParamsSchema.parse({ workspacePath: "/repo", extra: true }),
    ).toThrow();
  });

  it("accepts the strict provider list with nullable apiKey", () => {
    expect(
      zcodeUncensoredGetConfigResultSchema.parse({ providers: [providerConfig] }),
    ).toEqual({ providers: [providerConfig] });
    expect(
      zcodeUncensoredGetConfigResultSchema.parse({
        providers: [{ ...providerConfig, apiKey: null }],
      }),
    ).toEqual({ providers: [{ ...providerConfig, apiKey: null }] });
    expect(zcodeUncensoredGetConfigResultSchema.parse({ providers: [] })).toEqual({
      providers: [],
    });
  });

  it("rejects malformed providers, empty apiUrl and undeclared response fields", () => {
    expect(() =>
      zcodeUncensoredGetConfigResultSchema.parse({
        providers: [{ ...providerConfig, models: [{ id: "model-a", enabled: "yes" }] }],
      }),
    ).toThrow();
    expect(() =>
      zcodeUncensoredGetConfigResultSchema.parse({
        providers: [{ ...providerConfig, apiUrl: "" }],
      }),
    ).toThrow();
    expect(() =>
      zcodeUncensoredGetConfigResultSchema.parse({
        providers: [{ ...providerConfig, leaked: true }],
      }),
    ).toThrow();
  });

  it("keeps the status DTO free of the secret and rejects a leaked apiKey", () => {
    expect(
      zcodeUncensoredSettingsStatusSchema.parse({ providers: [providerStatus] }),
    ).toEqual({ providers: [providerStatus] });
    expect(() =>
      zcodeUncensoredSettingsStatusSchema.parse({
        providers: [{ ...providerStatus, apiKey: "secret" }],
      }),
    ).toThrow();
    expect(
      zcodeUncensoredSettingsWriteSchema.parse({ providers: [providerWrite] }),
    ).toEqual({ providers: [providerWrite] });
    expect(
      zcodeUncensoredSettingsWriteSchema.parse({
        providers: [{ ...providerWrite, apiKey: null }],
      }),
    ).toEqual({ providers: [{ ...providerWrite, apiKey: null }] });
    expect(
      zcodeUncensoredSettingsWriteSchema.parse({
        providers: [{ ...providerWrite, apiKey: undefined }],
      }),
    ).toEqual({ providers: [{ ...providerWrite, apiKey: undefined }] });
  });
});

describe("model.refusal session event", () => {
  it("declares the durable event type", () => {
    expect(zcodeSessionEventTypeSchema.parse("model.refusal")).toBe("model.refusal");
  });

  it("accepts the exact payload through the strict event envelope", () => {
    expect(parseRefusal(modelRefusalPayload)).toMatchObject({
      type: "model.refusal",
      payload: modelRefusalPayload,
    });
  });

  it("accepts the item bounds", () => {
    expect(parseRefusal({ ...modelRefusalPayload, itemIndex: 0 }).payload).toEqual({
      ...modelRefusalPayload,
      itemIndex: 0,
    });
    expect(parseRefusal({ ...modelRefusalPayload, itemText: "a".repeat(4000) }).payload).toEqual({
      ...modelRefusalPayload,
      itemText: "a".repeat(4000),
    });
  });

  it("rejects negative or fractional itemIndex", () => {
    expect(() => parseRefusal({ ...modelRefusalPayload, itemIndex: -1 })).toThrow();
    expect(() => parseRefusal({ ...modelRefusalPayload, itemIndex: 1.5 })).toThrow();
  });

  it("rejects empty or oversized itemText and missing reason", () => {
    expect(() => parseRefusal({ ...modelRefusalPayload, itemText: "" })).toThrow();
    expect(() => parseRefusal({ ...modelRefusalPayload, itemText: "a".repeat(4001) })).toThrow();
    const { reason: _reason, ...withoutReason } = modelRefusalPayload;
    expect(() => parseRefusal(withoutReason)).toThrow();
    expect(() => parseRefusal({ ...modelRefusalPayload, reason: "" })).toThrow();
  });

  it("rejects undeclared payload fields", () => {
    expect(() => parseRefusal({ ...modelRefusalPayload, modelId: "model-a" })).toThrow();
  });
});

describe("subagent row takeover extension", () => {
  it("accepts a row without takeover for backward compatibility", () => {
    expect(subagentRowSchema.parse(subagentRow())).toEqual(subagentRow());
  });

  it("accepts a row with a complete takeover including provider and terminal statuses", () => {
    expect(
      subagentRowSchema.parse(
        subagentRow({
          takeover: {
            taskId: "session-1",
            itemIndex: 0,
            itemText: "Fix the failing test",
            providerId: "provider-a",
            providerName: "Provider A",
            modelId: "model-a",
            status: "done",
            output: "result",
            reason: "content-filter",
          },
        }),
      ).takeover,
    ).toEqual({
      taskId: "session-1",
      itemIndex: 0,
      itemText: "Fix the failing test",
      providerId: "provider-a",
      providerName: "Provider A",
      modelId: "model-a",
      status: "done",
      output: "result",
      reason: "content-filter",
    });
    expect(
      subagentRowSchema.parse(
        subagentRow({
          takeover: {
            taskId: "session-1",
            itemIndex: 1,
            itemText: "Second item",
            modelId: null,
            status: "no-enabled-models",
            output: "",
          },
        }),
      ).takeover,
    ).toEqual({
      taskId: "session-1",
      itemIndex: 1,
      itemText: "Second item",
      modelId: null,
      status: "no-enabled-models",
      output: "",
    });
  });

  it("rejects a negative itemIndex", () => {
    expect(() =>
      subagentRowSchema.parse(
        subagentRow({
          takeover: {
            taskId: "session-1",
            itemIndex: -1,
            itemText: "Item",
            modelId: null,
            status: "error",
            output: "",
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects an unknown takeover status", () => {
    expect(() =>
      subagentRowSchema.parse(
        subagentRow({
          takeover: {
            taskId: "session-1",
            itemIndex: 0,
            itemText: "Item",
            modelId: null,
            status: "cancelled",
            output: "",
          },
        }),
      ),
    ).toThrow();
  });
});
