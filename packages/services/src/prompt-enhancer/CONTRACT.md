# prompt-enhancer

Host-сервис нативного «Enhance Prompt». Один канал `ServiceChannels.PromptEnhancer` обслуживает
Desktop Local Host, Remote SSH Server и Web Remote: клиент присылает черновик, сервис сам собирает
контекст и вызывает модель через инъецированный генератор.

## Инварианты

- **Один владелец запроса.** `enhance` держит `requestId` в `active` до `finally`; повторный
  `enhance` с тем же `requestId` падает `invalid_request` вместо второго параллельного вызова.
- **Один сигнал отмены.** Таймаут и `cancel` сводятся к одному `AbortController`; сервис не держит
  две ветки отмены и не «ждёт истечения таймаута» как способ синхронизации.
- **Черновик — достаточный вход.** Сбой сбора контекста (`contextPorts`) не отменяет улучшение:
  пустой контекст допустим, но ошибка модели — нет.
- **Protected mentions неизменны.** `@file`/`$skill` маркеры проверяются после первого ответа; при
  потере выполняется ровно один повтор с обратной связью, затем `unsupported_changes`.
- **Ответ валидируется контрактом клиента.** `promptEnhanceResultSchema.parse` на выходе: клиент и
  сервер не могут разойтись в форме результата.
- **Логи без содержимого.** `draftText`/`enhancedText` не попадают в `info`; старт — `debug`,
  завершение — `info`, ошибки — `warn`.

## Границы

- `requires: [services, shared]`. Гибридный поиск приходит через `PromptEnhanceCodeSearchPort`;
  подстановку конкретного `CodeIntelligenceService` делает Host-проводка
  (`packages/services/src/node/prompt-enhancer-ports.ts`), поэтому модуль не зависит от индекса кода
  и работает там, где индекса нет (Web/remote).
- Модель не создаётся здесь: `PromptEnhancerTextGenerator` реализуется поверх
  `zcodeAgentService.generateWorkspaceText`, то есть через существующий admission.
