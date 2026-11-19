# shared-stage4-settings

Единая Zod-схема настроек подсистем Этапов 4.1–4.6.

Инварианты:

- Модуль чистый: только схемы, дефолты и типы. Чтение/запись `setting.json` — у `settingService`,
  runtime-маппинг в CLI — у `services/setting/cliConfigSyncBridge`.
- Каждая секция имеет `.default(...)`, поэтому старые `setting.json` без новых ключей читаются
  без ошибок и получают дефолт (идемпотентная миграция на уровне схемы).
- Вложенные объекты `.strict()`: неизвестный ключ — ошибка контракта, а не тихо отброшенное значение.
- Секции — единственный источник значений для UI-настроек и Host'а: `chatAutocompleteSettings`,
  `proactiveSuggestionSettings`, `promptEnhancerSettings`, `agentCoreAdvanced`,
  `parallelJobsSettings`, `codeIndexSettings`, `sandboxSettings`, `browserAssistantSettings`.
- `chatAutocompleteSettings.enabled` по умолчанию `true` (ghost-подсказка работает без
  ручного opt-in). Стоимость ограничена дебаунсом 250–700 мс, `minPrefixChars = 6`,
  кэшем префиксов и бюджетом 48 выходных токенов на подсказку; при отсутствии сервиса
  или настройки `enabled = false` запросов нет.
- `proactiveSuggestionSettings.enabled` по умолчанию `true`, `maxSuggestionsPerTurn = 1`:
  подсказка создаётся только по focus/click на пустом композере после `completedSuccess`,
  никогда не отправляется сама и не повторяет запрос для уже полученного turn.
