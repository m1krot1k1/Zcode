# Cursor CLI model provider

## Назначение

Добавить Cursor CLI (`cursor-agent`) как локальный CLI-провайдер моделей рядом с OpenCode CLI.
Пользователь включает интеграцию в настройках, после чего модели `cursor-agent` появляются в
Composer как обычная группа провайдера с бейджем «CLI» и выбираются штатным `ModelSelection`.

Интеграция повторяет контракт OpenCode CLI (`docs/specs/opencode-cli-model-provider.md`) и не
изменяет существующую интеграцию OpenCode.

## Принятая модель владения

| Слой                                        | Владелец                                          | Ответственность                                                             |
| ------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Резолв бинаря, `--version`, `--list-models` | Host (`packages/services/src/cursor-cli-runtime`) | Единственный источник `CursorCliStatus` и каталога моделей                  |
| Публикация Provider в runtime catalog       | Host (`LocalCliProviderCatalogSource`)            | Публикует `cursor` только когда `cursorCliEnabled === true` и CLII доступен |
| Валидация wire-контракта                    | `packages/shared`                                 | Zod-схемы snapshot-а и настроек                                             |
| Запуск запроса                              | Agent worker (`apps/zcode-cli/packages/adapters`) | Спавнит `cursor-agent -p`, маппит stream-json в AI SDK stream parts         |
| Настройки и UX                              | Renderer (`packages/ui`)                          | Панель статуса, переключатель, группа в Composer                            |

Поток: `sharedSettings.cursorCliEnabled` → Host публикует `RuntimeProviderCatalogSnapshot`
(`providerId: "cursor"`, `api.type: "cursor-cli"`, `access.type: "local-auth"`) → worker
регистрирует Provider в Provider Registry → Composer выбирает модель → adapters запускают
`cursor-agent`.

## Идентичность провайдера

- `providerId`: `cursor`
- `providerName`: `Cursor CLI`
- `access`: `{ type: "local-auth" }`
- `api`: `{ type: "cursor-cli" }`, без `baseUrl` и `headers`
- `config.logo`: не задаётся (как у OpenCode CLI; UI показывает общий иконку-заглушку)
- Модели: `modelId` — идентификатор из `cursor-agent --list-models` (например `composer-1`,
  `claude-4.5-sonnet`), без namespace `provider/model`.

`local-auth` и `cursor-cli` допустимы только для built-in конфигурации ZCode, как и
`opencode-sdk`: personal provider rule их отвергает.

## Host: статус и каталог

`CursorCliRuntime` (модуль `cursor-cli-runtime`, слой adapters) предоставляет:

```ts
interface ICursorCliRuntime {
  getCliStatus(): Promise<CursorCliStatus>;
  listModels(): Promise<CursorCliModelCatalog>;
}
```

Резолв бинаря: `CURSOR_AGENT_PATH` (абсолютный путь) → `cursor-agent` в `PATH` →
`~/.local/bin/cursor-agent`. Статус:

- `available` — `cursor-agent --version` завершился с кодом 0; `version` — распознанная версия.
- `missing` — бинарь не найден.
- `unavailable` — бинарь есть, но `--version` упал или истёк таймаут.
- `timed-out` — таймаут резолва/проверки.

Каталог моделей: `cursor-agent models` (если команда доступна) или
`cursor-agent --list-models`; парсер толерантен к заголовкам, пустым строкам и маркерам
текущей модели. Если CLI вернул непустой список — он авторитетен. Если список пуст или
команда недоступна, публикуется документированный базовый набор (`cursor-baseline-models.ts`),
чтобы провайдер оставался выбираемым; такие модели помечаются `source: "baseline"`.

Установка в один клик (как у OpenCode CLI): `installCli()` выполняет официальный установщик
`curl https://cursor.com/install -fsS | bash` одним процессом (таймаут 180 с, фиксированная
команда без подстановок) и затем **проверяет** `cursor-agent --version`. Код выхода установщика
не считается доказательством установки: без успешной проверки возвращается
`install-verification-failed`. На Windows one-click установка не поддерживается
(`install-platform-unsupported`), панель показывает команду установки.

Сервис также отдаёт `getCliStatus`/`listModels`; после успешной установки панель перечитывает
модели, обновляет каталог Provider Registry и автоматически включает провайдер.

## Wire-контракт

`zcodeProviderUpdateRuntimeCatalogParamsSchema` расширяется обратносовместимо:

- `providers` — массив объединения `opencodeRuntimeProviderSchema | cursorRuntimeProviderSchema`.
- `cliExecutablePaths?: Record<string, string>` — карта `providerId → абсолютный путь бинаря`.
  Старое поле `cliExecutablePath` сохраняется для OpenCode; worker предпочитает карту.
- `cursorRuntimeModelIdSchema` — безопасная строка `[A-Za-z0-9._:/-]{1,128}`.

Worker инжектит путь из карты в `PATH` для соответствующего провайдера, не подменяя путь
другого CLI.

## Запуск запроса

Адаптер `cursor-provider.ts` реализует `LanguageModelV3` поверх одного процесса на вызов:

```
cursor-agent -p
  --output-format stream-json
  --stream-partial-output
  --model <modelId>
  --workspace <cwd>
  [--force]            # если модель разрешает правки без подтверждения (по умолчанию да)
```

Промпт собирается из `LanguageModelV3Prompt` (system + сообщения + tool-результаты) в
текстовый блок; изображения и файловые парты передаются как текстовые ссылки, потому что
print-режим Cursor не принимает AI SDK content parts.

Маппинг `stream-json`:

| Событие                 | Условие                                  | AI SDK stream part                                      |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `system`/`init`         | всегда                                   | игнорируется (метаданные сессии)                        |
| `user`                  | всегда                                   | игнорируется (эхо промпта)                              |
| `assistant`             | `timestamp_ms` есть, `model_call_id` нет | `text-delta` из `message.content[].text`                |
| `assistant`             | иначе                                    | игнорируется (дубликат, документированное правило)      |
| `tool_call`/`started`   | всегда                                   | `tool-call` (`providerExecuted: true`, `dynamic: true`) |
| `tool_call`/`completed` | всегда                                   | `tool-result` для того же `call_id`                     |
| `result`                | `is_error === true`                      | ошибка потока (`error` part)                            |
| `result`                | иначе                                    | `finish` (`stop`), `usage` не выдумывается              |
| не-JSON строка stderr   | всегда                                   | лог `warn`, поток не рвётся                             |

Отмена запроса убивает дочерний процесс (`SIGTERM` → `SIGKILL` по таймауту). Ненулевой код
выхода без `result`-события превращается в ошибку с хвостом stderr.

`doGenerate` использует тот же процесс с накоплением текста и tool-call частей.

## Reasoning levels and grouped catalog (2026-11-22)

`cursor-agent models` returns a flat list where every reasoning/speed combination is a
separate id (`gpt-5.3-codex-low`, `gpt-5.3-codex-low-fast`, `...-high`, `...-xhigh`).
Publishing those ids directly produced 285 near-duplicate Composer entries and a
`reasoningLevel: ["disabled"]` selector.

The Host now groups the flat catalog:

- `parseCursorModelId` recognizes trailing `fast`, `no-thinking` and reasoning tokens
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) while preserving
  `thinking` as part of the base identity; the two-token `extra-high` spelling is
  normalized to `xhigh` so `gpt-5.5-extra-high` stays in the `gpt-5.5` family;
- `groupCursorModels` emits one selector per base model (+ `-fast`), with ordered
  reasoning levels and the exact Cursor id for each level;
- the model config stores `optionSpecs.reasoningLevel.map` as restricted CEL that returns
  `{"modelId": "<actual-cursor-id>"}`; the adapter evaluates it before spawning
  `cursor-agent --model`, so the selected base model + level reaches the exact model;
- the model picker labels use `properties.displayName`; the Cursor settings summary shows
  grouped names/count instead of 285 raw entries.

Legacy persisted selections are migrated by `migrateLegacyModelSelection`:
`grok-4.7-xhigh-fast` becomes `grok-4.7-fast` + `reasoningLevel: xhigh`; a
`claude-haiku-5-5-low-no-thinking` keeps its `no-thinking` base. The migration is
lossless and never clears an explicit reasoning option for other providers. An id that
already exists in the grouped catalog is never re-parsed, so the `-fast` and
`-no-thinking` selectors keep the user's explicit reasoning level instead of being
migrated a second time.

The runtime caches status and catalog for 60 seconds and keeps the last successful
catalog when a refresh fails (for example, `api2.cursor.sh` DNS failure). This prevents a
transient network error from removing the provider and silently resetting the selected
Cursor model to `auto`. A failed refresh is cached for at most 15 seconds to avoid a
settings-refresh loop; the last good catalog remains authoritative until a new successful
`cursor-agent models` call.

## Отличия от OpenCode CLI (принятые и документированные)

1. Cursor использует собственные инструменты (файлы, shell); MCP-мост к инструментам ZCode не
   подключается. Это осознанно: print-режим Cursor не поддерживает инъекцию MCP-сервера через
   argv, а правка `~/.cursor/mcp.json` была бы побочным эффектом на пользовательской машине.
2. Нет managed-установки (см. выше).
3. `usage`/стоимость не публикуются: Cursor не документирует их в `stream-json`.

Эти отличия не меняют контракт данных Provider Registry и не влияют на OpenCode.

## Настройки и UX

- `sharedSettings.cursorCliEnabled: boolean` (default `false`), patch-схема — optional.
- Отдельный пункт `Cursor CLI` в боковой группе «Локальные CLI-провайдеры» рядом с
  `OpenCode CLI`; каждый пункт открывает свою панель.
- Панель `CursorAgentSettingsPanel`: статус, версия, список моделей (количество/имена),
  переключатель, «Установить» (когда CLI недоступен), «Проверить снова», подсказка с командой
  установки. Успешная установка включает провайдер; ошибка показывается кодом и не включает его.
- `buildRegistryModelSelectGroups`: `providerId === "cursor"` допускается при
  `local-auth` + `cursor-cli`; бейдж «CLI» ставится так же, как для OpenCode.
- Тексты — через `text-ui-*` токены, без произвольных размеров шрифта.

## Настройки агента

Ничего в поведении OpenCode не меняется: `openCodeCliEnabled`, `OpenCodeCliProviderCatalogSource`
и адаптер `opencode-provider.ts` остаются без изменений; композитный источник добавляет второй
provider независимо.

## Критерии приёмки

1. При `cursorCliEnabled === true` и доступном `cursor-agent` в Composer появляется группа
   `Cursor CLI` с бейджем «CLI» и моделями.
2. Выбор модели и отправка запроса идут через штатный Provider Registry; текст стримится, tool-call
   отображаются, отмена работает.
3. При `cursorCliEnabled === false` или отсутствии бинаря `cursor` provider не публикуется и
   Composer не меняется.
4. OpenCode CLI продолжает публиковаться и запускаться при `openCodeCliEnabled === true`
   (регрессия покрыта тестами).
5. Zod-схемы отвергают `local-auth`/`cursor-cli` вне built-in config и небезопасные model id.

## Тесты

- `packages/provider`: `cursor-cli` проходит api-shape, pair-rule, personal-rule; группировка
  reasoning/fast вариантов, restricted-CEL map и миграция legacy flat id покрыты
  `cursorModelGrouping.test.ts` и `model-selection-config.test.ts`; реальный каталог
  `cursor-agent` от 2026-11-22 (284 модели после отбрасывания строки `Tip:`) проецируется
  в 77 селекторов без дублей, включая `gpt-5.5-extra-high` → `gpt-5.5` + `xhigh`.
- `packages/shared`: парсинг snapshot с `cursor`, карта `cliExecutablePaths`, model id schema.
- `packages/services`: композитный каталог публикует 0/1/2 провайдера по флагам; резолвер и
  парсер `--list-models`; кэш статуса/каталога и last-good fallback.
- `apps/zcode-cli/.../bootstrap`: worker принимает `cursor`, инжектит путь в `PATH`;
  legacy flat selection мигрирует до валидации.
- `apps/zcode-cli/.../adapters`: маппинг stream-json (дельты, дубликаты, tool_call, result error),
  argv, отмена; map `reasoningLevel -> actual cursor id` применяется до `--model`.
- `packages/ui`: группа Composer для `cursor`, панель настроек и grouped summary.

## Вне области

- Переписывание OpenCode CLI.
- MCP-мост инструментов ZCode в Cursor.
- Публикация usage/стоимости.
