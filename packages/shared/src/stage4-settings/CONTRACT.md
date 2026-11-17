# shared-stage4-settings

Единая Zod-схема настроек подсистем Этапов 4.1–4.6.

Инварианты:

- Модуль чистый: только схемы, дефолты и типы. Чтение/запись `setting.json` — у `settingService`,
  runtime-маппинг в CLI — у `services/setting/cliConfigSyncBridge`.
- Каждая секция имеет `.default(...)`, поэтому старые `setting.json` без новых ключей читаются
  без ошибок и получают дефолт (идемпотентная миграция на уровне схемы).
- Вложенные объекты `.strict()`: неизвестный ключ — ошибка контракта, а не тихо отброшенное значение.
- Секции — единственный источник значений для UI-настроек и Host'а: `chatAutocompleteSettings`,
  `promptEnhancerSettings`, `agentCoreAdvanced`, `parallelJobsSettings`, `codeIndexSettings`,
  `sandboxSettings`, `browserAssistantSettings`.
