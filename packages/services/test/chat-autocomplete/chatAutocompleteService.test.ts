import { describe, expect, it, vi } from "vitest";
import {
  PrefixRingCache,
  createChatAutocompleteService,
  resolveAdaptiveDebounceMs,
  type ChatAutocompleteTextGenerator,
} from "../../src/chat-autocomplete/index.js";
import { UserLexiconStore, type LexiconFileBackend } from "../../src/chat-autocomplete/user-lexicon-store.js";
import type { ChatAutocompleteLexiconProfile } from "@zcode/shared";

const baseRequest = {
  requestId: "req_autocomplete_0001",
  workspacePath: "/repo/zcode",
  prefix: "исправь гонку субагентов в ",
};

function createGenerator(text: string): ChatAutocompleteTextGenerator & { calls: number } {
  const generator = {
    calls: 0,
    async generateText() {
      generator.calls += 1;
      return { text, selection: { providerId: "p", modelId: "fast" } };
    },
  };
  return generator;
}

class MemoryBackend implements LexiconFileBackend {
  readonly files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

function createLexicon(profile?: ChatAutocompleteLexiconProfile) {
  const backend = new MemoryBackend();
  if (profile) backend.files.set("/tmp/lexicon.json", JSON.stringify(profile));
  return new UserLexiconStore({ path: "/tmp/lexicon.json", backend, now: () => 1_000 });
}

describe("chat autocomplete service", () => {
  it("returns a cache hit without calling the model twice", async () => {
    const generator = createGenerator("режиме Swarm через FileLockRegistry");
    const service = createChatAutocompleteService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: createLexicon(),
    });
    const first = await service.complete(baseRequest);
    expect(first.source).toBe("model_stream");
    expect(first.suggestion).toContain("Swarm");
    const second = await service.complete({ ...baseRequest, requestId: "req_autocomplete_0002" });
    expect(second.source).toBe("prefix_cache_exact");
    expect(generator.calls).toBe(1);
  });

  it("skips generation when the cursor is not at the end of the thought", async () => {
    const generator = createGenerator("should not be used");
    const service = createChatAutocompleteService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: createLexicon(),
    });
    const response = await service.complete({ ...baseRequest, cursorAtEndOfLine: false });
    expect(response.suggestion).toBe("");
    expect(generator.calls).toBe(0);
  });

  it("rejects an invalid request before touching the model", async () => {
    const generator = createGenerator("x");
    const service = createChatAutocompleteService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: createLexicon(),
    });
    await expect(service.complete({ ...baseRequest, prefix: "ab" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(generator.calls).toBe(0);
  });

  it("aborts the stale request when a newer one arrives for the same workspace", async () => {
    const signals: AbortSignal[] = [];
    const generator: ChatAutocompleteTextGenerator = {
      async generateText(params) {
        signals.push(params.signal);
        if (signals.length === 1) {
          await new Promise((_, reject) => {
            params.signal.addEventListener("abort", () => reject(new Error("superseded")));
          });
        }
        return { text: "второй ответ", selection: { providerId: "p", modelId: "fast" } };
      },
    };
    const service = createChatAutocompleteService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: createLexicon(),
      requestTimeoutMs: 5_000,
    });
    const stale = service.complete(baseRequest);
    // Даём первому запросу дойти до генератора, затем приходит новое нажатие.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh = service.complete({
      ...baseRequest,
      requestId: "req_autocomplete_0002",
      prefix: "исправь гонку субагентов внутри ",
    });
    await expect(stale).rejects.toMatchObject({ code: "aborted" });
    await expect(fresh).resolves.toMatchObject({ source: "model_stream" });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("times out without leaking the user prefix into logs", async () => {
    const warn = vi.fn();
    const debug = vi.fn();
    const generator: ChatAutocompleteTextGenerator = {
      generateText: (params) =>
        new Promise((_, reject) => {
          params.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const service = createChatAutocompleteService({
      textGenerator: generator,
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: createLexicon(),
      requestTimeoutMs: 10,
      logger: { debug, info: vi.fn(), warn, error: vi.fn() },
    });
    await expect(service.complete(baseRequest)).rejects.toMatchObject({ code: "timeout" });
    const logged = JSON.stringify([...warn.mock.calls, ...debug.mock.calls]);
    expect(logged).not.toContain("субагентов");
  });

  it("hides failures quietly and reports model_unavailable without a resolver", async () => {
    const service = createChatAutocompleteService({
      textGenerator: createGenerator("x"),
      lexiconStore: createLexicon(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(service.complete(baseRequest)).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });

  it("records accepted suggestions into the lexicon without storing secrets", async () => {
    const lexicon = createLexicon();
    const service = createChatAutocompleteService({
      textGenerator: createGenerator("x"),
      modelResolver: { resolveDefaultSelection: async () => ({ providerId: "p", modelId: "fast" }) },
      lexiconStore: lexicon,
    });
    await service.recordAcceptedSuggestion({
      workspacePath: "/repo/zcode",
      fullPrompt: "исправь гонку субагентов sk-abcdefgh12345678 в FileLockRegistry",
      acceptedSlice: "FileLockRegistry",
    });
    const profile = await service.getLexiconProfile({ workspacePath: "/repo/zcode" });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("sk-");
    expect(profile?.preferredLanguage).toBe("ru");
    await service.clearLexiconProfile({ workspacePath: "/repo/zcode" });
    expect(await service.getLexiconProfile({ workspacePath: "/repo/zcode" })).toBeNull();
  });
});

describe("prefix ring cache", () => {
  it("returns exact, partial typing and backward deletion hits", () => {
    const cache = new PrefixRingCache({ limit: 4, now: () => 1 });
    cache.record("ws", "добавь тесты", " на реестр файлов");
    expect(cache.lookup("ws", "добавь тесты")).toMatchObject({ source: "prefix_cache_exact" });
    expect(cache.lookup("ws", "добавь тесты на")).toMatchObject({
      suggestion: " реестр файлов",
      source: "prefix_cache_partial",
    });
    const deleted = new PrefixRingCache({ now: () => 1 });
    deleted.record("ws", "добавь тесты на реестр", " файлов");
    expect(deleted.lookup("ws", "добавь тесты на")).toMatchObject({
      suggestion: " реестр файлов",
      source: "prefix_cache_backspace",
    });
  });

  it("evicts the oldest entry beyond the limit and ignores empty suggestion", () => {
    const cache = new PrefixRingCache({ limit: 2 });
    cache.record("ws", "a1b2c3", "one");
    cache.record("ws", "a1b2c4", "two");
    cache.record("ws", "a1b2c5", "three");
    expect(cache.size("ws")).toBe(2);
    expect(cache.lookupExact("ws", "a1b2c3")).toBeNull();
    cache.record("ws", "a1b2c6", "");
    expect(cache.size("ws")).toBe(2);
  });
});

describe("adaptive debounce", () => {
  it("keeps the configured floor for human typing speed", () => {
    expect(resolveAdaptiveDebounceMs(250, [300, 320, 280])).toBe(250);
  });

  it("grows up to 700 ms for machine-fast typing", () => {
    const fast = resolveAdaptiveDebounceMs(250, [40, 45, 50]);
    expect(fast).toBeGreaterThan(250);
    expect(fast).toBeLessThanOrEqual(700);
    expect(resolveAdaptiveDebounceMs(200, [100, 100, 100])).toBeGreaterThan(200);
  });
});
