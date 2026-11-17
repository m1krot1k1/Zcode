import {
  chatAutocompleteRequestSchema,
  type ChatAutocompleteRequest,
  type ChatAutocompleteResponse,
} from "@zcode/shared";
import type { ChatAutocompleteService } from "./contract.js";

/**
 * Стандартный вызов сервиса: композер спрашивает продолжение и отменяет
 * устаревший запрос, когда пользователь продолжил печатать.
 */
export function buildGhostRequest(
  requestId: string,
  prefix: string,
  settings: { debounceMs?: number; modelSelection?: { providerId: string; modelId: string } },
): ChatAutocompleteRequest {
  return chatAutocompleteRequestSchema.parse({
    requestId,
    workspacePath: "/repo/zcode",
    prefix,
    activeFilePath: "packages/ui/src/v4/ConversationComposer.tsx",
    ...(settings.debounceMs ? { debounceMs: settings.debounceMs } : {}),
    ...(settings.modelSelection ? { modelSelection: settings.modelSelection } : {}),
  });
}

/** Полный цикл: запрос подсказки, затем отмена предыдущего при новом нажатии. */
export async function completeThenCancelStale(
  service: ChatAutocompleteService,
  staleRequestId: string,
  next: ChatAutocompleteRequest,
): Promise<ChatAutocompleteResponse | null> {
  await service.cancel({ requestId: staleRequestId });
  try {
    return await service.complete(next);
  } catch {
    // Таймаут/отмена — штатное состояние ghost-текста: UI просто прячет подсказку.
    return null;
  }
}
