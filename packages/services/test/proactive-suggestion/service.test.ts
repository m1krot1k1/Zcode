import { describe, expect, it } from "vitest";
import type { ProactiveSuggestionRequest } from "@zcode/shared";

import { createProactiveSuggestionService } from "../../src/proactive-suggestion/service.js";

function buildRequest(
  overrides: Partial<ProactiveSuggestionRequest> = {},
): ProactiveSuggestionRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    draftEmpty: true,
    workspacePath: "/repo",
    context: {
      messages: [{ role: "user", text: "Добавь регрессионный тест" }],
      assistantResult: "Тест добавлен.",
      toolResults: [{ toolName: "bash", summary: "pnpm test passed" }],
      testResults: [{ toolName: "bash pnpm vitest run", status: "success", summary: "12 passed" }],
      diffs: [{ path: "packages/ui/test/a.test.ts", summary: "новый тест" }],
      openFiles: ["packages/ui/test/a.test.ts"],
    },
    ...overrides,
  };
}

function createService(text: string, messages: string[] = []) {
  return createProactiveSuggestionService({
    modelResolver: {
      async resolveDefaultSelection() {
        return { providerId: "p", modelId: "m" };
      },
    },
    textGenerator: {
      async generateText(params) {
        messages.push(params.messages.map((message) => message.content).join("\n---\n"));
        return { text, selection: { providerId: "p", modelId: "m" } };
      },
    },
  });
}

describe("proactive suggestion service", () => {
  it("пропускает пользовательский текст и содержит контракт промпта", async () => {
    const prompts: string[] = [];
    const service = createService("Добавь тест на отмену запроса", prompts);
    const response = await service.complete(buildRequest());
    expect(response.suggestion).toBe("Добавь тест на отмену запроса");
    expect(response.reason).toBeNull();
    expect(prompts[0]).toMatch(/write one short next task/i);
    expect(prompts[0]).toContain("bash: pnpm test passed");
    expect(prompts[0]).toContain("bash pnpm vitest run [success]: 12 passed");
    expect(prompts[0]).toContain("packages/ui/test/a.test.ts");
  });

  it("принимает полный снимок UI-лимитов и режет его за пределами схемы", async () => {
    const prompts: string[] = [];
    const service = createService("Проверь оставшиеся кейсы", prompts);
    const request = buildRequest({
      context: {
        ...buildRequest().context,
        diffs: Array.from({ length: 6 }, (_, index) => ({
          path: `packages/ui/file-${index}.ts`,
        })),
        openFiles: Array.from({ length: 16 }, (_, index) => `open-${index}.ts`),
        testResults: Array.from({ length: 4 }, (_, index) => ({
          toolName: "bash pnpm vitest run",
          status: "success",
          summary: `suite ${index} passed`,
        })),
      },
    });
    await expect(service.complete(request)).resolves.toMatchObject({
      suggestion: "Проверь оставшиеся кейсы",
    });

    // 17 openFiles / 7 diffs / 5 testResults больше лимитов wire-схемы (совпадает с UI).
    await expect(
      service.complete(
        buildRequest({
          requestId: "request-2",
          context: {
            ...buildRequest().context,
            testResults: Array.from({ length: 5 }, () => ({
              toolName: "vitest",
              status: "success",
              summary: "ok",
            })),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("режет ассистентский план", async () => {
    const service = createService("Сначала изучу файл и составлю план");
    const response = await service.complete(buildRequest());
    expect(response.suggestion).toBeNull();
    expect(response.reason).toBe("assistant_voice");
  });

  it("пустой ответ не падает", async () => {
    const service = createService("   \n  ");
    const response = await service.complete(buildRequest());
    expect(response.suggestion).toBeNull();
    expect(response.reason).toBe("empty_suggestion");
  });

  it("без резолвера модели возвращает model_unavailable", async () => {
    const service = createProactiveSuggestionService({
      textGenerator: {
        async generateText() {
          throw new Error("must not call");
        },
      },
    });
    await expect(service.complete(buildRequest())).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });

  it("таймаут прерывает зависший генератор", async () => {
    const service = createProactiveSuggestionService({
      requestTimeoutMs: 10,
      modelResolver: {
        async resolveDefaultSelection() {
          return { providerId: "p", modelId: "m" };
        },
      },
      textGenerator: {
        async generateText(params) {
          return await new Promise((_resolve, reject) => {
            params.signal.addEventListener("abort", () => reject(params.signal.reason));
          });
        },
      },
    });
    await expect(service.complete(buildRequest())).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("cancel прерывает in-flight запрос", async () => {
    const service = createProactiveSuggestionService({
      modelResolver: {
        async resolveDefaultSelection() {
          return { providerId: "p", modelId: "m" };
        },
      },
      textGenerator: {
        async generateText(params) {
          return await new Promise((_resolve, reject) => {
            params.signal.addEventListener("abort", () => reject(params.signal.reason));
          });
        },
      },
    });
    const request = buildRequest();
    const pending = service.complete(request);
    await service.cancel({ requestId: request.requestId });
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
