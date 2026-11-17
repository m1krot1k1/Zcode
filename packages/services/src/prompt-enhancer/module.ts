/**
 * `prompt-enhancer` манифест (architecture-governance managed module).
 * Слой adapters: сервис опирается на текстовый генератор Host'а и порты контекста,
 * но не импортирует runtime конкретных реализаций.
 *
 * `code-intelligence` намеренно отсутствует: гибридный поиск приходит через порт
 * `PromptEnhanceCodeSearchPort`, а конкретную реализацию подставляет Host-проводка
 * (`packages/services/src/node/prompt-enhancer-ports.ts`). Модуль не должен зависеть
 * от индекса кода, иначе Web/remote без индекса перестал бы собираться.
 */
export const promptEnhancerModule = {
  id: "prompt-enhancer",
  requires: ["services", "shared"],
  provides: ["prompt-enhancer"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
