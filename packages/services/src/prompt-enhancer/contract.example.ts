/**
 * prompt-enhancer: стандартный вызов сервиса Host'ом.
 *
 * Здесь показан ровно тот сценарий, который повторяют Desktop Local Host, Remote SSH
 * Server и Web Remote: собрать провода (генератор текста + порты контекста), создать
 * сервис, вызвать `enhance` и применить только `enhancedText`.
 */
import type { PromptEnhanceResult, PromptEnhanceStreamDelta } from "@zcode/shared";

import { createPromptEnhancerService, type PromptEnhancerService } from "./index.js";

export interface HostPromptEnhancerWiring {
  textGenerator: Parameters<typeof createPromptEnhancerService>[0]["textGenerator"];
  modelResolver?: Parameters<typeof createPromptEnhancerService>[0]["modelResolver"];
  contextPorts?: Parameters<typeof createPromptEnhancerService>[0]["contextPorts"];
}

export function createHostPromptEnhancer(wiring: HostPromptEnhancerWiring): PromptEnhancerService {
  return createPromptEnhancerService({
    textGenerator: wiring.textGenerator,
    ...(wiring.modelResolver ? { modelResolver: wiring.modelResolver } : {}),
    ...(wiring.contextPorts ? { contextPorts: wiring.contextPorts } : {}),
  });
}

/**
 * Один полный проход: подписка на дельты → запрос → применение результата.
 *
 * `applyEnhancedText` вызывается только для `enhancedText`; `usedContext` и `tokenDelta`
 * идут в UI как провенанс и не считаются содержимым файлов.
 */
export async function applyPromptEnhance(
  service: PromptEnhancerService,
  request: Parameters<PromptEnhancerService["enhance"]>[0],
  hooks: {
    applyEnhancedText(text: string): void;
    onDelta?: (event: PromptEnhanceStreamDelta) => void;
  },
): Promise<PromptEnhanceResult> {
  const unsubscribe = hooks.onDelta ? service.onStreamDelta(hooks.onDelta) : () => {};
  try {
    const result = await service.enhance(request);
    hooks.applyEnhancedText(result.enhancedText);
    return result;
  } finally {
    unsubscribe();
  }
}
