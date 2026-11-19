# services-proactive-suggestion

Host-сервис одной короткой подсказки следующей задачи (`ServiceChannels.ProactiveSuggestion`).

- Один активный запрос на workspace: новый `complete()` отменяет предыдущий
  (`AbortController`), идентичность — `workspaceIdentity?.trim() || workspacePath`.
- Бюджет: таймаут 8 с, `maxOutputTokens = 96`.
- Промпт пишет только голос пользователя: одна следующая задача, без плана
  ассистента и обращений к себе; основание — сообщения, результат ассистента,
  инструменты, результаты тестов, диффы и открытые файлы из запроса.
- `context.testResults` (`{ toolName, status, summary }`, до 4 записей) попадает
  в промпт блоком `Test results:` рядом с tool results; лимиты контекста и
  strict-схема принадлежат `@zcode/shared` и совпадают с UI-контекстом композера.
- `filterAssistantVoiceSuggestion` применяется к нормализованному тексту; пустой
  или ассистентский ответ → `{ suggestion: null, reason }`, не ошибка.
- Нет резолвера модели/`null` → `model_unavailable`.
- Транспорт и резолвер переиспользуются из `createChatAutocompletePaths` в
  registration; собственной копии нет.
