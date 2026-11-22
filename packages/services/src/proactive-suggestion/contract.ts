import { ServiceChannels } from "@zcode/shared";
import type {
  ProactiveSuggestionCancel,
  ProactiveSuggestionErrorCode,
  ProactiveSuggestionRequest,
  ProactiveSuggestionResponse,
} from "@zcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

/** Унифицированная ошибка канала proactive-suggestion. */
export class ProactiveSuggestionError extends Error {
  readonly code: ProactiveSuggestionErrorCode;

  constructor(code: ProactiveSuggestionErrorCode, message: string) {
    super(message);
    this.name = "ProactiveSuggestionError";
    this.code = code;
  }
}

export interface ProactiveSuggestionService {
  complete(request: ProactiveSuggestionRequest): Promise<ProactiveSuggestionResponse>;
  cancel(params: ProactiveSuggestionCancel): Promise<void>;
}

export const IProactiveSuggestionService = createServiceDescriptor<ProactiveSuggestionService>(
  ServiceChannels.ProactiveSuggestion,
);
