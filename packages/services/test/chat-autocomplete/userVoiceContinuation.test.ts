import { describe, expect, it } from "vitest";
import {
  createChatAutocompleteService,
  UserLexiconStore,
  type ChatAutocompleteContextPorts,
  type ChatAutocompleteTextGenerator,
  type LexiconFileBackend,
} from "../../src/chat-autocomplete/index.js";

const DRAFT =
  "Что из не только новых но и любых технологий любых годов нам можно и нужно интегрировать что бы система работала безупречно четко и быстро";
const ASSISTANT_PLAN = "Сначала изучу текущую архитектуру и `searchChannels.ts`, затем проверю";
const USER_CONTINUATION = " стоит брать только зрелые и проверенные инструменты";

const baseRequest = {
  requestId: "req_user_voice_0001",
  workspacePath: "/repo/zcode",
  prefix: DRAFT,
};

function createGenerator(
  text: string,
  captured: Array<Parameters<ChatAutocompleteTextGenerator["generateText"]>[0]> = [],
): ChatAutocompleteTextGenerator & { calls: number } {
  const generator = {
    calls: 0,
    async generateText(params: Parameters<ChatAutocompleteTextGenerator["generateText"]>[0]) {
      generator.calls += 1;
      captured.push(params);
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

function createService(
  generator: ChatAutocompleteTextGenerator,
  contextPorts?: ChatAutocompleteContextPorts,
) {
  return createChatAutocompleteService({
    textGenerator: generator,
    modelResolver: {
      resolveDefaultSelection: async () => ({
        providerId: "p",
        modelId: "fast",
      }),
    },
    ...(contextPorts ? { contextPorts } : {}),
    // Изолированный профиль лексики: тест не читает и не пишет реальный ~/.zcode.
    lexiconStore: new UserLexiconStore({
      path: "/tmp/ghost-user-voice-lexicon.json",
      backend: new MemoryBackend(),
      now: () => 1_000,
    }),
  });
}

describe("chat autocomplete user voice", () => {
  it("prompts the model to continue the user's draft with anti-assistant rules and context", async () => {
    const captured: Array<Parameters<ChatAutocompleteTextGenerator["generateText"]>[0]> = [];
    const service = createService(createGenerator(USER_CONTINUATION, captured), {
      history: {
        readRecentMessages: async () => [
          { role: "user", text: "Нужен быстрый поиск каналов" },
          {
            role: "assistant",
            text: "Сейчас в searchChannels.ts линейный скан",
          },
        ],
      },
      diffs: {
        listChangedFiles: async () => ["packages/services/src/search/searchChannels.ts"],
      },
    });

    const response = await service.complete({
      ...baseRequest,
      sessionId: "sess_1",
      activeFilePath: "/repo/zcode/packages/services/src/search/searchChannels.ts",
      openTabPaths: ["/repo/zcode/packages/shared/src/chat-autocomplete/contract.ts"],
    });

    // `clipGhostSuggestion` срезает ведущие пробелы — проверяем голос, а не разметку пробела.
    expect(response.suggestion.trim()).toBe(USER_CONTINUATION.trim());
    const call = captured[0];
    expect(call).toBeDefined();
    const system = call!.messages.find((message) => message.role === "system")?.content ?? "";
    const user = call!.messages.find((message) => message.role === "user")?.content ?? "";

    expect(system).toContain("user's own draft");
    expect(system).toContain("Never answer the draft");
    expect(system).toContain("assistant plan");
    expect(system).toContain("Сначала изучу");
    expect(system).toContain("Затем проверю");
    expect(system).toContain("Let me");
    expect(call!.maxOutputTokens).toBe(48);

    expect(user).toContain("NOT sent yet");
    expect(user).toContain("Do not answer the draft");
    expect(user).toContain("Cursor position: at the end of the draft");
    expect(user).toContain(`Draft before the cursor:\n${DRAFT}`);
    expect(user).toContain(
      "Active file: /repo/zcode/packages/services/src/search/searchChannels.ts",
    );
    expect(user).toContain(
      "Open files: /repo/zcode/packages/shared/src/chat-autocomplete/contract.ts",
    );
    expect(user).toContain("Changed files: packages/services/src/search/searchChannels.ts");
    expect(user).toContain("user: Нужен быстрый поиск каналов");
    expect(user).toContain("Continuation (start exactly at the cursor, user voice, one line):");
  });

  it("filters the observed assistant plan for the Russian draft and does not cache it", async () => {
    const generator = createGenerator(ASSISTANT_PLAN);
    const service = createService(generator);

    await expect(service.complete(baseRequest)).rejects.toMatchObject({
      code: "empty_suggestion",
    });
    // Отфильтрованный ответ не попадает в PrefixRingCache — второй запрос снова идёт в модель.
    await expect(
      service.complete({ ...baseRequest, requestId: "req_user_voice_0002" }),
    ).rejects.toMatchObject({ code: "empty_suggestion" });
    expect(generator.calls).toBe(2);
  });

  it("accepts a user-voice continuation for the same draft", async () => {
    const generator = createGenerator(USER_CONTINUATION);
    const service = createService(generator);

    const response = await service.complete(baseRequest);
    expect(response.source).toBe("model_stream");
    expect(response.suggestion.trim()).toBe(USER_CONTINUATION.trim());
    expect(response.suggestion.trimStart().startsWith("Сначала")).toBe(false);
  });

  it("filters an assistant plan even when the model repeats the draft prefix", async () => {
    const generator = createGenerator(`${DRAFT} Затем проверю`);
    const service = createService(generator);

    await expect(service.complete(baseRequest)).rejects.toMatchObject({
      code: "empty_suggestion",
    });
  });

  it("treats empty and broken model output as empty_suggestion without crashing", async () => {
    for (const text of ["", "   ", "\n\n"]) {
      const service = createService(createGenerator(text));
      await expect(service.complete(baseRequest)).rejects.toMatchObject({
        code: "empty_suggestion",
      });
    }
  });
});
