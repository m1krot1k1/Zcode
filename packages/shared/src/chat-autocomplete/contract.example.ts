import {
  chatAutocompleteRequestSchema,
  chatAutocompleteResponseSchema,
  type ChatAutocompleteRequest,
  type ChatAutocompleteResponse,
} from "./contract.js";
import { removePrefixOverlap, takeNextWord } from "./postprocess.js";

/** Композер отправляет префикс до курсора и открытые файлы — ровно как в UI. */
export function buildComposerAutocompleteRequest(prefix: string): ChatAutocompleteRequest {
  return chatAutocompleteRequestSchema.parse({
    requestId: "req_autocomplete_0001",
    workspacePath: "/repo/zcode",
    prefix,
    activeFilePath: "packages/ui/src/v4/ConversationComposer.tsx",
    openTabPaths: ["packages/ui/src/v4/ConversationComposer.tsx"],
  });
}

/** Ответ уже очищен от наложения префикса: UI вставляет его как ghost-суффикс. */
export function applySuggestion(
  prefix: string,
  response: ChatAutocompleteResponse,
): { ghostText: string; firstWord: string; rest: string } {
  const parsed = chatAutocompleteResponseSchema.parse(response);
  const ghostText = removePrefixOverlap(prefix, parsed.suggestion);
  const { word, rest } = takeNextWord(ghostText);
  return { ghostText, firstWord: word, rest };
}

/** Минимальный ответ из кэша префиксов: модель не вызывалась. */
export function buildCacheResponse(requestId: string): ChatAutocompleteResponse {
  return chatAutocompleteResponseSchema.parse({
    requestId,
    suggestion: "режиме Swarm через FileLockRegistry",
    source: "prefix_cache_partial",
    latencyMs: 0,
  });
}
