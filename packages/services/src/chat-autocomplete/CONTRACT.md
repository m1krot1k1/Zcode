# services-chat-autocomplete

Host-сервис предиктивного ghost-text (`ServiceChannels.ChatAutocomplete`).

Зачем модуль существует: композеру нужна подсказка-продолжение за десятки миллисекунд,
не выжигая токены и не мигая между запросами. Сбор контекста, дебаунс, кэш и профиль
лексики должны жить на одной стороне (Host), чтобы Desktop, SSH Server и Web Remote
видели идентичное поведение.

Инварианты:

- **Один активный запрос на workspace.** Новый `complete()` отменяет предыдущий
  (`AbortController`) до обращения к модели. Идентичность workspace —
  `workspaceIdentity?.trim() || workspacePath`.
- **Кэш префиксов до модели.** `PrefixRingCache` отдаёт `exact` → `partial_typing` →
  `backward_deletion`; попадание никогда не вызывает `textGenerator`.
- **Бюджет модели фиксирован:** `maxOutputTokens <= 48`, `reasoningLevel: "none"`,
  таймаут `<= 1200 мс`. Ответ обрезается до одной строки и не содержит префикса.
- **Профиль лексики — единственный владелец файла `v2/user-lexicon.json`.** Запись
  атомарная и сериализована очередью; текст проходит `sanitizeForLexicon`.
- **Текст подсказки не логируется.** Логи содержат только `requestId`, `source`,
  `latencyMs` и счётчики.
- Ошибки `aborted` / `timeout` / `empty_suggestion` — штатный результат (debug),
  `model_failed` — предупреждение.

Точки пересечения:

- `ui-lexical-ghost-autocomplete` вызывает сервис через `useChatAutocomplete` и
  передаёт настройки (`context`, `debounceMs`, `modelSelection`) в запросе.
- `prompt-enhancer` не участвует; улучшение промпта и ghost-подсказка —
  независимые операции с разными бюджетами.
