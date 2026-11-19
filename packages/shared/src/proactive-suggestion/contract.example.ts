import { proactiveSuggestionRequestSchema, type ProactiveSuggestionRequest } from "./contract.js";

/** Типовой запрос из UI после focus на пустом композере завершённого turn. */
export function buildProactiveSuggestionRequest(input: {
  requestId: string;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  assistantResult: string | null;
}): ProactiveSuggestionRequest {
  return proactiveSuggestionRequestSchema.parse({
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    draftEmpty: true,
    workspacePath: input.workspacePath,
    context: {
      messages: [],
      assistantResult: input.assistantResult,
      toolResults: [],
      // Короткие резюме прогонов: имя инструмента/команды, статус и summary.
      testResults: [{ toolName: "bash pnpm vitest run", status: "success", summary: "12 passed" }],
      diffs: [],
      openFiles: [],
    },
  });
}
