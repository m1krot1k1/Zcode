import type { ProactiveSuggestionRequest } from "@zcode/shared";

import type { ProactiveSuggestionService } from "./contract.js";

/** Полный цикл: запрос подсказки и отмена, когда композер потерял фокус. */
export async function requestThenCancelOnBlur(
  service: ProactiveSuggestionService,
  request: ProactiveSuggestionRequest,
  shouldCancel: () => boolean,
) {
  if (shouldCancel()) {
    await service.cancel({ requestId: request.requestId });
    return null;
  }
  return service.complete(request);
}
