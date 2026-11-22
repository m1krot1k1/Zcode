# shared-proactive-suggestion

Чистый контракт проактивной подсказки следующей задачи в композере.

- Запрос: `sessionId`/`turnId`, `draftEmpty: true`, необязательный курсор,
  workspace и снимок контекста (сообщения, ответ ассистента, инструменты,
  результаты тестов, диффы, открытые файлы).
- Лимиты: 8 сообщений × 600 символов, ответ ассистента 1200, 8 результатов
  инструментов × 400, 4 результата тестов (`toolName` 120, `status` 40,
  `summary` 300), 6 диффов × 300, 16 открытых файлов. Те же числа и поля
  экспортирует UI-контекст `PROACTIVE_SUGGESTION_CONTEXT_LIMITS`; менять их
  можно только синхронно (иначе strict-схема даёт `invalid_request`).
- `testResults` — короткие резюме прогонов (`{ toolName, status, summary }`),
  а не сырой вывод; сервис передаёт их в промпт вместе с прочим контекстом.
- Ответ: `{ suggestion: string | null, reason: empty_suggestion | assistant_voice | null }`.
  Отфильтрованный/пустой ответ не является ошибкой транспорта.
- Ошибки: `invalid_request`, `aborted`, `timeout`, `assistant_voice`,
  `empty_suggestion`, `model_unavailable`, `model_failed`.
- Настройка `proactiveSuggestionSettings` (`enabled` по умолчанию `true`,
  `maxSuggestionsPerTurn = 1`) принадлежит `settingService`.
