import { describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@zcode/contracts";
import {
  attributeTodoItem,
  attributeTurnItem,
  buildTakeoverRequestBody,
  detectRefusal,
  detectTextRefusal,
  runUncensoredTakeover,
  selectContextFragments,
  takeoverAgentId,
  takeoverIdempotencyKey,
  UNCENSORED_TAKEOVER_ENTRY_TYPE,
  TAKEOVER_MAX_USER_CONTENT_CHARS,
  type TakeoverFetch,
  type UncensoredConfigPort,
} from "../src/runtime/uncensored-takeover/index.js";

function todo(content: string, status: TodoItem["status"]): TodoItem {
  return { content, priority: "high", status };
}

type ProviderConfig = {
  id: string;
  name: string;
  apiUrl: string;
  apiKey: string | null;
  providerId?: string | null;
  models: Array<{ id: string; enabled: boolean }>;
};

function config(
  overrides: Partial<{
    apiKey: string | null;
    models: Array<{ id: string; enabled: boolean }>;
    providers: ProviderConfig[];
  }> = {},
): UncensoredConfigPort {
  const providers = overrides.providers ?? [
    {
      id: "provider-1",
      name: "Provider 1",
      apiUrl: "https://takeover.test/v1/chat",
      apiKey: overrides.apiKey === undefined ? "secret-key" : overrides.apiKey,
      models: overrides.models ?? [{ enabled: true, id: "m1" }],
    },
  ];
  return { getConfig: async () => ({ providers }) };
}

function fakeFetch(
  responder: (modelId: string, call: { body: string; headers: Record<string, string> }) => {
    status?: number;
    body?: string;
  },
): { fetch: TakeoverFetch; calls: Array<{ body: string; headers: Record<string, string> }> } {
  const calls: Array<{ body: string; headers: Record<string, string> }> = [];
  const fetch: TakeoverFetch = async (_url, init) => {
    const parsed = JSON.parse(init.body) as { model: string };
    calls.push({ body: init.body, headers: init.headers });
    expect(init.redirect).toBe("error");
    const reply = responder(parsed.model, { body: init.body, headers: init.headers });
    return {
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      text: async () => reply.body ?? "",
    };
  };
  return { calls, fetch };
}

const doneBody = (content: string) =>
  JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] });
const refusalBody = (reason = "refusal") =>
  JSON.stringify({ choices: [{ finish_reason: reason, message: { content: "" } }] });

describe("detectRefusal", () => {
  it.each(["refusal", "content_filter"])("triggers on %s", (reason) => {
    expect(detectRefusal({ finishReason: reason })).not.toBeNull();
  });

  it.each(["stop", "tool_calls", "length", "unknown", "", "SAFETY", "blocked"])(
    "does not trigger on %s",
    (reason) => {
      expect(detectRefusal({ finishReason: reason })).toBeNull();
    },
  );

  it("never detects from a clarifying question text (finish reason only)", () => {
    expect(detectRefusal({ finishReason: "stop", rawFinishReason: "stop" })).toBeNull();
  });

  it("reads the raw finish reason when the normalized one is generic", () => {
    expect(detectRefusal({ finishReason: "other", rawFinishReason: "content_filter" })).toBe(
      "content-filter",
    );
  });
});

describe("detectTextRefusal", () => {
  it.each([
    "I can't help with that.",
    "I'm sorry, but I cannot assist with this request.",
    "I won't do that.",
    "Не могу помочь с этим.",
    "无法帮助完成这个请求。",
  ])("detects %s", (text) => {
    expect(detectTextRefusal(text, { hasToolCalls: false })).toBe("text-refusal");
  });

  it.each([
    "I can't find the file.",
    "Can you clarify which file?",
    "The command failed with exit code 1.",
    "The tests passed.",
  ])("does not detect %s", (text) => {
    expect(detectTextRefusal(text, { hasToolCalls: false })).toBeNull();
  });

  it("never fires after a tool call", () => {
    expect(detectTextRefusal("I can't help with that.", { hasToolCalls: true })).toBeNull();
  });
});

describe("attributeTodoItem", () => {
  it("attributes the only pending item of ten (index 9)", () => {
    const todos = [
      ...Array.from({ length: 9 }, (_, index) => todo(`done ${index}`, "completed")),
      todo("refused item", "pending"),
    ];
    expect(attributeTodoItem(todos)).toEqual({ itemIndex: 9, itemText: "refused item" });
  });

  it("prefers the first in_progress item", () => {
    const todos = [
      todo("first pending", "pending"),
      todo("second in progress", "in_progress"),
      todo("third in progress", "in_progress"),
    ];
    expect(attributeTodoItem(todos)?.itemIndex).toBe(1);
  });

  it("returns null for empty and all-completed lists", () => {
    expect(attributeTodoItem([])).toBeNull();
    expect(attributeTodoItem([todo("a", "completed"), todo("b", "completed")])).toBeNull();
  });

  it("truncates item text to 4000 characters with an ellipsis", () => {
    const item = attributeTodoItem([todo("x".repeat(5000), "pending")]);
    expect(item?.itemText.length).toBe(4000);
    expect(item?.itemText.endsWith("…")).toBe(true);
  });
});

describe("attributeTurnItem", () => {
  it("prefers the tracked todo", () => {
    expect(
      attributeTurnItem(
        [todo("first", "pending"), todo("second", "in_progress")],
        "chat text",
      ),
    ).toEqual({ itemIndex: 1, itemText: "second" });
  });

  it("falls back to the last user message when no todo is actionable", () => {
    expect(attributeTurnItem([], "  explain this   file  ")).toEqual({
      itemIndex: 0,
      itemText: "explain this file",
    });
    expect(attributeTurnItem([todo("done", "completed")], "hello")).toEqual({
      itemIndex: 0,
      itemText: "hello",
    });
  });

  it("returns null for empty text", () => {
    expect(attributeTurnItem([], "   ")).toBeNull();
  });

  it("truncates the fallback to the item bound", () => {
    expect(attributeTurnItem([], "x".repeat(5000))?.itemText.length).toBeLessThanOrEqual(4000);
  });
});

describe("takeover request body", () => {
  it("contains exactly two messages and no full-prompt/history/other-item sentinels", () => {
    const fullPrompt = "SENTINEL_SYSTEM_PROMPT";
    const history = "SENTINEL_FULL_HISTORY";
    const otherItem = "SENTINEL_OTHER_ITEM";
    const itemText = "Fix src/app.ts rendering";
    const body = buildTakeoverRequestBody({
      modelId: "m1",
      itemIndex: 3,
      itemText,
      fragments: selectContextFragments({
        itemText,
        results: [
          {
            index: 0,
            isError: false,
            readOnly: true,
            text: `read src/app.ts output ${history}`,
            toolCallId: "c1",
            toolName: "Read",
          },
          {
            index: 1,
            isError: true,
            readOnly: true,
            text: "error sentinel",
            toolCallId: "c2",
            toolName: "Read",
          },
          {
            index: 2,
            isError: false,
            readOnly: false,
            text: "write sentinel",
            toolCallId: "c3",
            toolName: "Write",
          },
        ],
      }),
    });
    const serialized = JSON.stringify(body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(serialized).toContain(itemText);
    expect(serialized).not.toContain(fullPrompt);
    expect(serialized).not.toContain(otherItem);
    expect(serialized).not.toContain("error sentinel");
    expect(serialized).not.toContain("write sentinel");
    expect(body.messages[1].content.length).toBeLessThanOrEqual(TAKEOVER_MAX_USER_CONTENT_CHARS);
    expect(body).toMatchObject({ max_tokens: 4096, model: "m1", stream: false });
  });

  it("keeps at most three fragments and prioritizes path matches", () => {
    const itemText = "Fix src/app.ts";
    const fragments = selectContextFragments({
      itemText,
      results: Array.from({ length: 5 }, (_, index) => ({
        index,
        isError: false,
        readOnly: true,
        text: index === 0 ? "contents of src/app.ts" : `unrelated output ${index}`,
        toolCallId: `c${index}`,
        toolName: "Read",
      })),
    });
    expect(fragments).toHaveLength(3);
    expect(fragments[0]?.matchedPath).toBe("src/app.ts");
  });
});

describe("runUncensoredTakeover routing", () => {
  const base = {
    itemIndex: 0,
    itemText: "finish the item",
    fragments: [],
    taskId: "session-1",
    workspace: { workspacePath: "/workspace" },
  };

  it("tries enabled models in order; first refusal advances to the second", async () => {
    const { fetch, calls } = fakeFetch((modelId) =>
      modelId === "m1" ? { body: refusalBody() } : { body: doneBody("done by m2") },
    );
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: config({
        models: [
          { enabled: true, id: "m1" },
          { enabled: false, id: "skipped" },
          { enabled: true, id: "m2" },
        ],
      }),
      fetch,
    });
    expect(terminal).toEqual({
      status: "done",
      providerId: "provider-1",
      providerName: "Provider 1",
      modelId: "m2",
      output: "done by m2",
    });
    expect(calls.map((call) => JSON.parse(call.body).model)).toEqual(["m1", "m2"]);
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret-key");
  });

  it("falls through to the next provider when the first provider fails", async () => {
    const { fetch, calls } = fakeFetch((modelId) =>
      modelId === "p1-m1" ? { body: refusalBody() } : { body: doneBody("done by p2-m1") },
    );
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: config({
        providers: [
          {
            id: "p1",
            name: "Provider 1",
            apiUrl: "https://p1.test/v1/chat",
            apiKey: "k1",
            models: [{ id: "p1-m1", enabled: true }],
          },
          {
            id: "p2",
            name: "Provider 2",
            apiUrl: "https://p2.test/v1/chat",
            apiKey: "k2",
            models: [{ id: "p2-m1", enabled: true }],
          },
        ],
      }),
      fetch,
    });
    expect(terminal).toEqual({
      status: "done",
      providerId: "p2",
      providerName: "Provider 2",
      modelId: "p2-m1",
      output: "done by p2-m1",
    });
    expect(calls.map((call) => JSON.parse(call.body).model)).toEqual(["p1-m1", "p2-m1"]);
    expect(calls[1]?.headers.Authorization).toBe("Bearer k2");
  });

  it("advances after an HTTP error and returns the last status when all fail", async () => {
    const { fetch, calls } = fakeFetch((modelId) =>
      modelId === "m1" ? { status: 500, body: "boom" } : { body: refusalBody("content_filter") },
    );
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: config({
        models: [
          { enabled: true, id: "m1" },
          { enabled: true, id: "m2" },
        ],
      }),
      fetch,
    });
    expect(terminal.status).toBe("refused");
    expect(terminal.modelId).toBe("m2");
    expect(calls).toHaveLength(2);
  });

  it("makes zero fetch calls when no model is enabled", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: doneBody("never") }));
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: config({ models: [{ enabled: false, id: "m1" }] }),
      fetch,
    });
    expect(terminal).toEqual({
      status: "no-enabled-models",
      providerId: null,
      providerName: null,
      modelId: null,
      output: "",
    });
    expect(calls).toHaveLength(0);
  });

  it("makes zero fetch calls when config is null", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: doneBody("never") }));
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: { getConfig: async () => null },
      fetch,
    });
    expect(terminal).toEqual({
      status: "error",
      providerId: null,
      providerName: null,
      modelId: null,
      output: "",
      reason: "config",
    });
    expect(calls).toHaveLength(0);
  });

  it("does not send Authorization for an empty key", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: doneBody("ok") }));
    await runUncensoredTakeover({ ...base, configPort: config({ apiKey: "" }), fetch });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("uses the mirrored provider generate path when providerId is present", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: doneBody("raw") }));
    const generate = vi.fn(async () => ({ text: "done by mirror", finishReason: "stop" }));
    const terminal = await runUncensoredTakeover({
      ...base,
      configPort: config({
        providers: [
          {
            id: "entry-1",
            providerId: "mirror-1",
            name: "Provider 1",
            apiUrl: "https://p1.test/v1/chat",
            apiKey: "k1",
            models: [{ id: "m1", enabled: true }],
          },
        ],
      }),
      generate: { generate },
      fetch,
    });
    expect(terminal).toEqual({
      status: "done",
      providerId: "mirror-1",
      providerName: "Provider 1",
      modelId: "m1",
      output: "done by mirror",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

describe("plain-chat item splitting", () => {
  it("picks the numbered item mentioned in the refusal", () => {
    const userText =
      "Сделай:\n1. Add the parser\n2. Fix the deploy script\n3. Update the docs";
    expect(
      attributeTurnItem([], userText, "I can't fix the deploy script without credentials."),
    ).toEqual({ itemIndex: 1, itemText: "Fix the deploy script" });
  });

  it("falls back to the first item for a generic refusal", () => {
    expect(
      attributeTurnItem([], "1. first thing\n2. second thing", "I can't help with that."),
    ).toEqual({ itemIndex: 0, itemText: "first thing" });
  });

  it("keeps the whole message when it is not a list", () => {
    expect(attributeTurnItem([], "Please refactor the module", "I can't help with that.")).toEqual({
      itemIndex: 0,
      itemText: "Please refactor the module",
    });
  });
});

describe("takeover idempotency identity", () => {
  it("is stable for the same task and whitespace-normalized item text", () => {
    expect(takeoverIdempotencyKey("s1", "  fix   it ")).toBe(takeoverIdempotencyKey("s1", "fix it"));
    expect(takeoverAgentId("s1", 2, "fix it")).toMatch(
      /^uncensored-takeover:s1:2:[0-9a-f]{16}$/,
    );
  });

  it("differs for a different item text", () => {
    expect(takeoverAgentId("s1", 2, "fix it")).not.toBe(takeoverAgentId("s1", 2, "fix that"));
  });

  it("uses the declared durable entry type", () => {
    expect(UNCENSORED_TAKEOVER_ENTRY_TYPE).toBe("runtime/uncensored_takeover");
  });
});
