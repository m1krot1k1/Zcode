# uncensored-settings

Модуль существует как единственная точка доступа к настройкам нецензурированной модели:
URL endpoint'а, write-only API-ключ и упорядоченный список моделей для fallback-перехвата.

Инварианты:

- Единственный владелец состояния — файл `<indexRootDir>/uncensored-settings.json` плюс
  `ICredentialService` под ключом `code-intelligence:<workspaceKey>:uncensored-api-key`.
  Сервис не кэширует настройки и не читает credential store для статуса.
- `updateConfig` — полная замена записи workspace. `apiUrl: null` сбрасывает URL, модели и
  секрет; пустой `apiKey` сохраняет текущий секрет; `null` удаляет; непустая строка
  пишется в credential store. Секрет никогда не попадает в JSON, статус, ответ UI или логи.
- `workspaceKey = sha256(workspaceIdentity?.trim() || workspacePath).hex.slice(0, 32)` —
  тот же ключ, что у code intelligence; записи других workspace сохраняются.
- Запись атомарна: временный файл в том же каталоге + `rename` под очередью по пути файла.
  Битый JSON читается как настройки по умолчанию, без исключения.
- Валидация: абсолютный `http(s)` URL с host, без userinfo/query/fragment, pathname непустой
  и не `/`; до 50 моделей, `id` после trim непустой и уникальный, `enabled` — boolean.

Hook points:

- UI вызывает `IUncensoredSettingsService.getConfig/updateConfig` (renderer→Host), секрет
  не получает.
- `uncensored/getConfig` (CLI→Host reverse RPC) использует host-only
  `readTakeoverConfig`: тот же store, секрет читается непосредственно перед сборкой ответа.
- Композиция: `node/features.ts` создаёт `createUncensoredSettingsStore(...)` и передаёт его
  в `createUncensoredSettingsService({ store })`; отдельного писателя нет.
