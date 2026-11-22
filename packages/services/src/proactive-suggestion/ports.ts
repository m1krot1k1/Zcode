/**
 * Порты proactive-suggestion. Форма структурно совпадает с
 * `createChatAutocompletePaths`, поэтому registration переиспользует тот же
 * транспорт/резолвер и не создаёт второй владелец модели.
 */

export interface ProactiveSuggestionTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: {
      providerId: string;
      modelId: string;
      options?: { reasoningLevel?: string };
    };
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    querySource: string;
    maxOutputTokens?: number;
    signal: AbortSignal;
  }): Promise<{
    text: string;
    selection: { providerId: string; modelId: string };
  }>;
}

export interface ProactiveSuggestionModelResolver {
  resolveDefaultSelection(): Promise<{
    providerId: string;
    modelId: string;
    reasoningLevels?: readonly string[];
  } | null>;
}

export interface ProactiveSuggestionPorts {
  textGenerator: ProactiveSuggestionTextGenerator;
  modelResolver?: ProactiveSuggestionModelResolver;
}

