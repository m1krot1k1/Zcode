# Явный запуск локальной модели (Local Model Explicit Start)

Статус: **proposed**, 2026-11-20. Код не реализован. Спецификация фиксирует контракт до
реализации, чтобы не появился второй владелец состояния и «удобная» автозагрузка.

## 1. Назначение

Локальная open-weights модель (первый кандидат — `Qwen3.8-27B` + pi-адаптер) должна
запускаться, скачиваться и появляться в каталоге ZCode **только после явной команды
пользователя**. При старте приложения, открытии настроек, входе в чат или выборе модели
система не должна:

- спавнить процесс сервера;
- проверять `localhost`/`/health`/`/v1/models`;
- скачивать веса;
- регистрировать provider или модель;
- писать локальный provider в `provider_config.json`;
- молча переключаться на облако при недоступном локальном сервере.

Причина: локальный сервер — дорогой внешний процесс (память, диск, GPU), а его наличие в
каталоге — продуктовое обещание. Автозагрузка превращает «доступную возможность» в
«скрытый фон», который пользователь не заказывал.

## 2. Инварианты

- **I1. Ноль действий до start.** В состоянии `stopped` запрещены spawn, download, probe,
  регистрация, запись provider-конфига.
- **I2. Provider живёт только в `ready`.** В `stopped`/`starting`/`stopping`/`failed` его
  нет в model list и в `ProviderSettingsView`.
- **I3. Нет silent fallback.** Если локальный сервер недоступен, запрос не уходит в облако
  и не подменяется другой моделью; пользователь видит локальную ошибку.
- **I4. Только loopback.** Сервер слушает `127.0.0.1`/`::1`, порт эфемерный, токен
  эфемерный. Никакого `0.0.0.0`.
- **I5. Stop убивает process tree.** `/local stop`, выход из приложения и crash-handler
  не оставляют сирот.
- **I6. Restart приложения = `stopped`.** Предыдущий `ready` не восстанавливается
  автоматически.
- **I7. `/start` не перегружается.** `/start <task>` остаётся gateway-агентом
  (`ZCODE_NATIVE_AGENT_COMMANDS.start`). Локальная команда — `/local start`.

## 3. Термины и владельцы

| Термин             | Значение                                       | Владелец                               |
| ------------------ | ---------------------------------------------- | -------------------------------------- |
| Local runtime      | Процесс vLLM/llama.cpp + веса + health         | `LocalModelRuntimeService` (host/main) |
| Local provider     | In-memory `Provider` для Registry              | `LocalModelProviderCatalogSource`      |
| Local session      | Сессия, выбравшая локальную модель             | Session/runtime config                 |
| Start command      | `/local start`                                 | Protocol/CLI command handler           |
| Local-lite profile | Ограниченный tool surface для локальной модели | Runtime `toolAllowlist`                |

`LocalModelRuntimeService` — единственный владелец процесса, порта, токена, download и
health. `LocalModelProviderCatalogSource` не спавнит и не качает; он только отражает
состояние runtime в `RuntimeProviderCatalogSnapshot`.

## 4. State machine

```
stopped --(/local start)--> starting --(health ok)--> ready
                                   \--(error)-------> failed
ready --(/local stop | app quit)--> stopping --> stopped
ready --(crash)-------------------> failed
failed --(/local start)-----------> starting
```

Правила:

- Переходы инициируются только командой или смертью процесса. Нет таймеров, которые
  «сами поднимут» сервер.
- В `starting` provider ещё не публикуется; UI показывает прогресс, но модель не selectable.
- В `failed` provider снимается; ошибка сохраняется для `/local status`; auto-retry нет.
- В `stopping` новые запросы не принимаются; процесс получает SIGTERM, затем SIGKILL по
  таймауту.
- При старте приложения state = `stopped`; `read()` источника возвращает пустой snapshot.

## 5. Интеграция с Provider Registry

Использовать существующий механизм runtime-провайдеров, а не personal config:

- `packages/provider/src/sources.ts`: `RuntimeProviderCatalogSnapshot { revision, providers }`.
- `packages/provider/src/registry-service.ts`: runtime providers мержатся в общий Registry
  вместе с built-in/account/personal.
- `packages/services/src/model-provider/providerRuntime.ts`:
  `OpenCodeCliProviderCatalogSource` — уже существующий precedent in-memory провайдера.
- `packages/services/src/zcode-agent/zcodeAgentServiceParams.ts`:
  `runtimeProviderCatalogSource?: ProviderSource<RuntimeProviderCatalogSnapshot>`.

Предлагаемая проводка:

```
LocalModelRuntimeService
  └─ onDidChange(reason)
       └─ LocalModelProviderCatalogSource implements ProviderSource<RuntimeProviderCatalogSnapshot>
            └─ createZCodeAgentService({ runtimeProviderCatalogSource })
                 └─ ProviderRegistryService.replace([...registryProviders, ...runtimeProviders])
```

Если в хосте уже есть OpenCode source, нужен **composite source**, который:

- объединяет провайдеров обоих источников;
- считает revision как композицию revision'ов;
- пробрасывает `onDidChange` от обоих;
- корректно dispose'ит оба.

Нельзя молча заменить OpenCode source локальным: это сломает существующий каталог.

`read()` локального source:

```ts
if (state !== "ready") {
  return { revision: "local:stopped", providers: [] };
}
return {
  revision: `local:${engine}:${modelId}:${version}`,
  providers: [provider],
};
```

`read()` в `stopped` **не делает** fetch/spawn. Это тестируемый инвариант I1.

## 6. Команды

```
/local start [--engine vllm|llama.cpp] [--model qwen3.8-pi] [--yes]
/local stop
/local status
```

### `/local start`

1. Проверить память, диск, наличие бинаря и весов.
2. Если памяти недостаточно — отказать с числами (нужно/доступно), не пытаться запустить
   Q4 на 16 ГБ.
3. Если весов нет — показать размер, источник, лицензию и запросить подтверждение.
   `--yes` пропускает только это подтверждение, не проверки безопасности.
4. Выделить эфемерный loopback-порт и токен.
5. Запустить сервер с `--host 127.0.0.1`, thinking off, prefix caching.
6. Дождаться `/health` и `/v1/models` с таймаутом; при ошибке — `failed` и лог.
7. Опубликовать provider, выбрать модель в текущей сессии (или предложить выбор).
8. Записать в лог только факт запуска, engine, model, port; **не** токен и не промпты.

### `/local stop`

1. Перевести state в `stopping`, снять provider.
2. SIGTERM, ждать exit, при необходимости SIGKILL process tree.
3. `stopped`; если локальная модель была выбрана — снять выбор и вернуть ошибку
   «локальная модель остановлена», без автоматического переключения на другую модель.

### `/local status`

Показать state, engine, model, port, health, memory, last error. Не запускать ничего.

### Почему не `/start`

`/start` уже маршрутизирует задачу через профиль `start` и `Task(start)`
(`apps/zcode-cli/packages/bootstrap/src/builtin-prompt-command.ts`). Перегрузка `/start`
запуском сервера сломает существующий контракт и создаст два значения одной команды.
Явная команда — `/local start`; допустимый alias — `/local-model start`. Имя `local` нужно
добавить в reserved names, иначе пользовательская slash-команда сможет его перехватить.

## 7. Provider contract

| Поле            | Значение                                          |
| --------------- | ------------------------------------------------- |
| providerId      | `local-qwen` (стабильный)                         |
| providerName    | `Local Qwen3.8-27B`                               |
| api.type        | `openai-chat-completions`                         |
| baseUrl         | `http://127.0.0.1:<ephemeral>/v1`                 |
| apiKey          | эфемерный токен (не логировать)                   |
| modelId         | `qwen3.8-pi`                                      |
| contextWindow   | `131072`                                          |
| maxOutputTokens | `32768`                                           |
| input           | text                                              |
| output          | text                                              |
| thinking        | off на сервере (`--default-chat-template-kwargs`) |

Правила:

- **Не** полагаться на `detectApiFormat`: адаптер обучен на Chat Completions, а
  auto-detect может выбрать Responses, если сервер ответит на `/responses`. Формат
  фиксируется вручную.
- **Не** вызывать `discoverProviderModels` до `ready`; после `ready` можно, но это
  необязательно.
- **Не** писать provider в personal config; только runtime snapshot.
- При падении сервера provider снимается; запросы к нему не ретраятся в облако.

## 8. Local-lite tool profile

Цель — приблизить tool surface к pi (4–7 инструментов) и снять 77% схемы.

| Параметр        | Значение                                                                    |
| --------------- | --------------------------------------------------------------------------- |
| `toolAllowlist` | `Read`, `Bash`, `Edit`, `Write`, `Grep`, `Glob`                             |
| optional        | `ApplyPatch` только если нужен для multi-file patch                         |
| prompt          | короткий local profile; без PRISM/полного ZCode preamble                    |
| hidden          | `Agent`, `Task`, `Workflow`, `Cron*`, `OffPeak*`, `Skill*`, `EnterPlanMode` |
| permissions     | обычные ZCode permissions; не yolo                                          |

Опциональный pi-compat projection (отдельный model-visible слой, внутренние handlers
остаются ZCode):

| pi                      | ZCode                                        | Преобразование                                                  |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `read.path`             | `Read.file_path`                             | переименовать                                                   |
| `write.path`            | `Write.file_path`                            | переименовать                                                   |
| `edit.path` + `edits[]` | `Edit.file_path` + `old_string`/`new_string` | v1: только один edit; multi-edit → `MultiEdit` или явная ошибка |
| `bash.timeout` (сек)    | `Bash.timeout` (мс)                          | ×1000                                                           |
| `find`                  | `Glob`                                       | pattern/path                                                    |
| `ls`                    | `Bash`/`Glob`                                | листинг                                                         |

Если projection не включается, модель должна адаптироваться по schema в контексте; это
менее надёжно и должно проверяться метрикой malformed tool calls.

## 9. Запрещённые действия до start

Явный чеклист для code review и тестов:

- `child_process.spawn`/`execFile` для сервера;
- `fetch` на `127.0.0.1`/`localhost` с `/health`, `/v1/models`, `/chat/completions`;
- `detectApiFormat`;
- `discoverProviderModels`;
- `testModelConnectivity`;
- `createPersonalProvider`/`savePersonalProviderOverlay`;
- запись `provider_config.json`;
- публикация provider в `RuntimeProviderCatalogSnapshot`;
- показ модели в `ModelSelectionView`.

При старте приложения допускается только чтение **несекретных** настроек (engine, путь к
весам, выбранный профиль), но не запуск и не probe.

## 10. Ошибки и деградация

| Ситуация                           | Поведение                                                      |
| ---------------------------------- | -------------------------------------------------------------- |
| Недостаточно RAM                   | `failed`, точные числа, предложить меньший квант/другую модель |
| Нет бинаря                         | `failed`, ссылка на установку, без авто-установки              |
| Нет весов                          | `failed`, размер/лицензия, запрос подтверждения                |
| Health timeout                     | `failed`, лог, без auto-retry                                  |
| Crash в `ready`                    | provider снимается, `failed`, без auto-restart                 |
| `/local stop` во время turn        | turn получает локальную ошибку, без cloud fallback             |
| Повторный `/local start` в `ready` | idempotent: вернуть status, не спавнить второй процесс         |

## 11. Безопасность

- Только loopback; проверять hostname, не доверять строке URL.
- Эфемерный токен; не писать в логи, не отдавать в UI.
- Sanitized env для child process: без API keys облачных провайдеров, без `SSH_AUTH_SOCK`,
  без лишних токенов.
- Ограничить размер download и проверить checksum/подпись, если доступна.
- Не включать `yolo` для локальной модели по умолчанию.
- Локальная модель всё равно проходит через ZCode permissions; она не получает
  дополнительные права.

## 12. Тесты

### Unit

1. `LocalModelProviderCatalogSource.read()` в `stopped` возвращает пустой snapshot и **не**
   вызывает fetch/spawn (mock).
2. `start()`: `stopped → starting → ready`, provider появляется, revision меняется.
3. `stop()`: `ready → stopping → stopped`, provider исчезает.
4. Crash: `ready → failed`, provider исчезает, auto-restart не вызывается.
5. Composite source: OpenCode + local, независимые revision, dispose обоих.
6. Command parser: `/local start`, `/local stop`, `/local status`; `/start` не перехватывается.

### E2E (desktop local)

1. Запуск приложения без команды: в model list нет локальной модели; нет child process;
   нет запросов к loopback.
2. `/local start` с mock download/health: provider появляется, модель выбирается, сообщение
   уходит на локальный endpoint.
3. `/local stop`: provider исчезает, процесс завершён, выбор снят.
4. Перезапуск приложения после `ready`: state `stopped`, provider нет.
5. Crash сервера: provider исчезает, ошибка видна, облачная модель не подставляется.
6. `/start <task>` по-прежнему уходит в start-агент.

### Регрессия

- `ProviderRegistryService` с runtime source не ломает built-in/personal providers.
- `ModelSelectionView` не показывает stopped local provider.
- Настройки не пишут local provider в personal config.

## 13. Открытые вопросы

1. Где хранить веса: app data, пользовательская папка, внешний диск?
2. Поддержка Windows/Linux: vLLM не нативно; llama.cpp — основной кросс-платформенный путь.
3. Детект GPU/памяти: какие пороги для Q4/Q8/BF16?
4. Download UX: resume, checksum, зеркала, лицензия.
5. Порт и stale process: как находить и убивать сирот после crash?
6. Нужен ли auto-restart после crash? По умолчанию — нет; только явный `/local start`.
7. Local-lite: per-session или глобальный профиль? Как переключать?
8. Совместимость с OpenCode runtime source: composite или список sources в API?
9. Нужен ли pi-compat projection в v1 или сначала измерить прямой перенос?
10. Как поступать с локальной моделью в субагентах/фоновых агентах: запрещать или
    наследовать? По умолчанию — запрещать, чтобы не плодить процессы и не терять
    управление.

## 14. Связанные документы

- `docs/research/2026-11-20-qwen38-pi-adapter-zcode-integration.md` — анализ адаптера,
  цифры и A/B.
- `docs/specs/max-turns-limit.md` — лимиты turn/субагентов.
- `docs/specs/2026-11-18-parallel-tools-and-async-agents.md` — параллельные tools/Agent.
- `packages/provider/src/sources.ts` — `RuntimeProviderCatalogSnapshot`.
- `packages/services/src/model-provider/providerRuntime.ts` — precedent in-memory provider.
