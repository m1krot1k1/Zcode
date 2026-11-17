# Этап 1: Инструментальный аудит архитектуры Zcode, криминалистическая диагностика и базовые метрики

**Дата аудита:** `2026-11-16`  
**Репозиторий:** `<home>/Desktop/git/Zcode` (ветка `main`, базовый коммит `48870824fb`, последний релизный тег `v2.68.1`)  
**Статус исходного кода:** Не модифицирован (строгое соблюдение режима read-only для `apps/**`, `packages/**`, `config/**`; все локальные изменения пользователя в рабочем дереве сохранены нетронутыми).

---

## 1. Базовая линия репозитория, архитектурные границы и релизный конвейер (Linux и macOS)

### 1.1. Состояние рабочего дерева и веток

Инструментальная проверка базовой линии перед началом аудита показала следующее состояние:

1. **Проверка свежести workspace (`node scripts/check-workspace-freshness.mjs`):**  
   Завершена со статусом `OK` (`exit code 0`), рассинхронизации сборок внутренних пакетов и `node_modules` не обнаружено. Среда исполнения зафиксирована в [`mise.toml`](mise.toml:1) и [`.nvmrc`](.nvmrc:1) (**Node.js 24**, `pnpm 10.30.3`).
2. **Ветки и история Git:**  
   - Активная ветка: `main` (отслеживает `origin/main`).
   - Ветка `dev`: **отсутствует** как локально, так и в `origin` (`git branch -a` содержит только `main` и `remotes/origin/main`; разработка ведётся в trunk-based модели с короткими feature/release PR в `main`).
   - Последний аннотированный релизный тег: `v2.68.1` (серия тегов `v2.67.x` → `v2.68.1`).
   - В рабочем дереве присутствуют незакоммиченные локальные правки разработчика (в т.ч. конфигурация локализации `ru-RU`, настройки провайдеров и UI-компоненты), а также исследуемый дамп [`session_dee7732e677519c63e3dd10d5eeeaaff.zcode-session`](session_dee7732e677519c63e3dd10d5eeeaaff.zcode-session). Все существующие локальные файлы сохранены без изменений.
3. **Архитектурный гейт (`pnpm architecture:check --changed`):**  
   Выполнен по правилам [`.agents/skills/architecture-governance/SKILL.md`](.agents/skills/architecture-governance/SKILL.md:1) и [`architecture-policy.yaml`](architecture-policy.yaml:1). Результат: **`0` новых нарушений архитектурных границ, `0` циклических зависимостей** (`exit code 0`). Политика контролирует 9 иерархических слоёв (`shared` → `rpc` → `services` / `client` → `ui` → `desktop` / `web` / `server` + автономный контур `apps/zcode-cli`) и запрещает прямой импорт внутренних модулей в обход публичных `contract.ts` / `index.ts`.

### 1.2. Релизный конвейер и сборка под Linux и macOS

Система версионирования и выпуска релизов опирается на связку [`.release-it.mjs`](.release-it.mjs:1), корневого [`package.json`](package.json:1), сборочных скриптов в `scripts/` и пайплайнов GitHub Actions в `.github/workflows/`.

| Этап конвейера | Артефакты и скрипты | Особенности Linux (`x64` / `arm64`) | Особенности macOS (`arm64` / `x64`) |
| --- | --- | --- | --- |
| **1. Бамп версии и тегирование** | [`.release-it.mjs`](.release-it.mjs:1), `scripts/sync-version.mjs` | Синхронизирует версию `package.json` во всех workspace-пакетах (`desktop`, `zcode-cli`, `zcode-server-cli`), создаёт коммит `chore(release): v${version}` и тег `v*`, триггерящий workflow релиза. | Аналогично (единая версия монорепозитория). |
| **2. Подготовка встроенного Agent CLI и нативного поиска** | [`scripts/build-desktop-agent-cli.mjs`](scripts/build-desktop-agent-cli.mjs:1), [`scripts/build-desktop-agent-bytecode.mjs`](scripts/build-desktop-agent-bytecode.mjs:1), [`scripts/build-native-search-tools.mjs`](scripts/build-native-search-tools.mjs:1) | Бандлит `apps/zcode-cli` через `esbuild`/`tsup`, компилирует защищённый V8-байткод (`.jsc`) под ABI целевого Electron/Node, упаковывает `@vscode/ripgrep` и встроенные плагины (`browser-use-plugin`, `document-skills-plugin`) в `extraResources`. | Дополнительно подготавливает универсальные или поархитектурные (`arm64`, `x64`) бинарники, выставляет права `+x` на `rg` и `node-pty` `spawn-helper`. |
| **3. Computer Use Helper** | [`packages/services/src/node/cua-helpers.ts`](packages/services/src/node/cua-helpers.ts:338), `.github/workflows/release*.yml` | **Отсутствует**: CUA Helper не собирается и не упаковывается под Linux (`platform === "darwin" \|\| platform === "win32"`). | В `Resources/cua-helper/` вкладывается подписанный бандл `ZCode Computer Use.app` с отдельными TCC-правами (`Accessibility`, `ScreenCapture`). |
| **4. Упаковка Electron Desktop** | `packages/desktop/electron-builder.yml`, [`packages/desktop/package.json`](packages/desktop/package.json:1) | Через `electron-builder --linux` выпускаются **`AppImage`**, **`deb`**, **`rpm`** (и `tar.gz` при необходимости) для `x64` и `arm64`. Нативные аддоны (`node-pty`) пересобираются под ABI Electron. | Через `electron-builder --mac` выпускаются **`dmg`** и **`zip`** (для автообновления `electron-updater`) под `arm64` (Apple Silicon) и `x64` (Intel), выполняется подпись Developer ID и Apple Notarization (`afterSign`). |
| **5. Сборка Headless / Remote Server CLI** | [`packages/zcode-server-cli`](packages/zcode-server-cli/vitest.config.ts:1), `.github/workflows/` | Выпускается standalone-архив `zcode-server-linux-{x64,arm64}.tar.gz` с демоном/супервизором (`systemd` user service через [`serviceManager.ts`](packages/zcode-server-cli/src/platform/serviceManager.ts:1)) для SSH/Remote Workspace подключений. | Выпускается `zcode-server-darwin-{arm64,x64}.tar.gz` с интеграцией `launchd` (`LaunchAgents`). |

---

## 2. Карта подсистем монорепозитория и контрактов владения состоянием

Монорепозиторий разделён на два крупных контура исполнения, общающихся через строго типизированный двунаправленный JSON-RPC 2.0 поверх `stdio` (**ZCode Protocol**):

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ UI Renderer (packages/ui, packages/desktop/src/renderer, packages/web)       │
│  • ConversationComposer / LexicalChatInput / SettingsPage / PreviewPane      │
│  • Zustand UI-store + проекции v4 snapshot (без прямого доступа к ФС/SQLite) │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ MessagePort / WebSocket RPC (@zcode/rpc, @zcode/client)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Window-Scoped Local Host / Server Host (packages/services, packages/desktop) │
│  • ZCodeAgentService / ZCodeSessionService (маршрутизация к CLI)             │
│  • CodeIntelligenceService (SQLite индекс кода в ~/.zcode/code-intelligence) │
│  • SettingService (~/.zcode/v2/setting.json), TerminalService (node-pty)     │
│  • CUA Permission Broker (macOS/Windows Helper), Git/File services           │
└───────────────┬───────────────────────────────────────────────┬──────────────┘
                │ Electron Main (окна, трей, TaskRealtimeBus)   │ stdio JSONL (ZCode Protocol)
                ▼                                               ▼
┌───────────────────────────────┐   ┌──────────────────────────────────────────┐
│ Native OS / Browser Views     │   │ Agent Runtime CLI (apps/zcode-cli)       │
│  • WebContentsView (IAB CDP)  │   │  • bootstrap: ZCodeProtocolAgentServer   │
│  • CUA Helper (macOS/Win)     │   │  • core: AgentRuntime, CommandInbox,     │
└───────────────────────────────┘   │    turn loop, Compact, Subagent Runner   │
                                    │  • tools: Read/Write/Edit/ApplyPatch/    │
                                    │    Bash/Grep/Glob/CodeIndex/Agent/MCP    │
                                    │  • adapters: Vercel AI SDK providers,    │
                                    │    SQLite (~/.zcode/cli/db/db.sqlite)    │
                                    └──────────────────────────────────────────┘
```

### Сводная таблица пакетов и ответственности

| Пакет / Директория | Ключевые точки входа | Зона ответственности и владение состоянием |
| --- | --- | --- |
| `apps/zcode-cli/packages/contracts` | `apps/zcode-cli/packages/contracts/src/index.ts` | Zod-схемы инструментов (`Read`, `Write`, `Edit`, `ApplyPatch`, `Bash`, `Grep`, `Glob`), порты (`FileSystemPort`, `ExecutionPort`, `CodeIntelligencePort`, `BrowserControlPort`), типы событий сессии. |
| `apps/zcode-cli/packages/core` | [`agent-runtime.ts`](apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts:349), `runtime/methods/turn.ts`, `tool/executor/call-runner.ts` | Главный агентный цикл, сериализация команд через `CommandInbox`, системные промпты, microcompact/autocompact, реестр и исполнение инструментов, оркестрация субагентов (`Agent` / Swarm / Coordinator). **Единственный владелец истины по истории диалога и состоянию хода.** |
| `apps/zcode-cli/packages/adapters` | `model/`, [`exec/index.ts`](apps/zcode-cli/packages/adapters/src/exec/index.ts:1), `fs/`, `storage/` | LLM-адаптеры на базе `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` (с локальными `patches/`), неинтерактивный исполнитель `NodeExecutionAdapter`, ripgrep-обёртка, персистентность сессий в `~/.zcode/cli/db/db.sqlite` и `cli/artifacts/`. |
| `apps/zcode-cli/packages/bootstrap` | [`create-app-session.ts`](apps/zcode-cli/packages/bootstrap/src/app/create-app-session.ts:488), [`server-operations-part6.ts`](apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations-part6.ts:255) | Сборка CLI-приложения, JSON-RPC сервер поверх `stdio`, обратные вызовы в Host (`code-intelligence/query`, `interaction/browserExecute`, запросы разрешений). |
| `packages/shared` | `src/zcode-protocol/index.ts`, `src/platform.ts`, [`shared-channels-part1.ts`](packages/shared/src/shared-channels-part1.ts:168) | Общие схемы протокола Host↔CLI, `AppSettings`, идентификация `workspaceIdentity?.trim() \|\| workspacePath`, интерфейс `IPlatformService`. |
| `packages/rpc` & `packages/client` | [`remoteServiceAccess.ts`](packages/client/src/remoteServiceAccess.ts:123), [`messageport.ts`](packages/client/src/messageport.ts:29) | Мультиплексированный RPC (`ChannelServer` / `ChannelClient` / `ProxyChannel`) поверх `MessagePort` (Desktop) и `WebSocket` (Web / Remote SSH / Mobile Relay). |
| `packages/services` | [`registration.ts`](packages/services/src/node/registration.ts:471), [`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:78), [`settingService.ts`](packages/services/src/setting/settingService.ts:224) | Бизнес-сервисы Local/Remote Host: управление процессом `zcode-cli`, индекс кода `ICodeIntelligenceService`, настройки `ISettingService`, терминалы `node-pty`, Git, плагины, CUA broker. |
| `packages/desktop` | [`renderer/src/main.tsx`](packages/desktop/src/renderer/src/main.tsx:334), `src/main/`, `src/host/` | Electron Main (окна, нативные меню, `TaskRealtimeBus`, встроенный браузер IAB на `WebContentsView`), процесс Window-Scoped Local Host и точка монтирования Renderer. |
| `packages/ui` | [`Root.tsx`](packages/ui/src/Root.tsx:1), [`ConversationComposer.tsx`](packages/ui/src/v4/ConversationComposer.tsx:100), [`SettingsPage.tsx`](packages/ui/src/SettingsPage.tsx:29) | Все общие React-компоненты Desktop и Mobile/Web: чат v4, `LexicalChatInput`, slash/mention меню, `SettingsPage`, `CodeGraphExplorer`, `PreviewPane`, `Terminal`. |
| `packages/web`, `packages/server`, `packages/zcode-server-cli` | [`serviceManager.ts`](packages/zcode-server-cli/src/platform/serviceManager.ts:1) | Веб-клиент, удалённый сервер и CLI-демон для SSH/Remote и мобильного релея (`web-remote-replayable`). |

---

## 3. Криминалистическая реконструкция сессии `session_dee7732e677519c63e3dd10d5eeeaaff` (Задача 1)

### 3.1. Паспорт инцидента и первичные артефакты

Сопоставлены три независимых первичных источника:
1. Сырой журнал рантайма CLI: `<home>/.zcode/cli/log/zcode-2026-11-16.jsonl` (включая события потоков `turn`, `model`, `tool`, `subagent`, `compact`).
2. Сериализованный снимок сессии: [`session_dee7732e677519c63e3dd10d5eeeaaff.zcode-session`](session_dee7732e677519c63e3dd10d5eeeaaff.zcode-session) (JSON-экспорт дерева сообщений, `parts`, `usage` и метаданных).
3. Исходный код `apps/zcode-cli` и `packages/services`.

**Точные параметры сессии:**
- **Session ID:** `session_dee7732e677519c63e3dd10d5eeeaaff`
- **Рабочая директория (`workspacePath`):** `<home>/Desktop/test-zcode/new` (fullstack-проект Python FastAPI + React/TypeScript Vite).
- **Временное окно:** `2026-11-16T16:07:21.751Z` — `2026-11-16T16:33:13.681Z` (**25 мин 51.9 сек**).
- **Провайдер и модель:** кастомный OpenAI-совместимый провайдер `custom-openai-compatible-mnu97l6p-chat` → OpenRouter API → модель **`qwen/qwen3.6-plus`** (`contextWindow = 1_000_000`, потолок генерации **`maxOutputTokens = 16_384`**).
- **Режим оркестрации:** `swarm` / Coordinator (`collaborationMode = "coordinator"`) с порождением параллельных дочерних субагентов `general-purpose` (в частности `agent-a44c3399`, `agent-ae31523f`, `agent-a90b79d4`) в **общей рабочей директории** без git-worktree изоляции.
- **Суммарный расход ресурсов за одну задачу:** **108 вызовов LLM**, пиковый входной контекст одного запроса — **444 198 токенов**, кумулятивный объём входных токенов — **~20.47 млн токенов**, при этом **`cacheReadTokens = 0` на протяжении всей сессии**.

### 3.2. Посекундная реконструкция ключевых фаз и сбоев

| Время (UTC) | Агент / Поток | Действие / Вызов инструмента | Фактический исход в JSONL и `.zcode-session` | Корневой механизм в коде |
| --- | --- | --- | --- | --- |
| `16:07:21.751Z` | Main (`dee7732e...`) | Старт сессии, приём промпта пользователя на разработку fullstack-системы в `<home>/Desktop/test-zcode/new`. | Инициализация `AgentRuntime`; `buildCodeIndexTurnHint` возвращает `null`, так как индекс для `<home>/Desktop/test-zcode/new` не создан (`ENOENT` → `unindexed`), да и для `.py` индекс не работает. | [`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:183), [`runtime-reminders.ts`](apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts:340) |
| `16:07:23Z` – `16:09:10Z` | Main Coordinator | Первичная разведка (`Glob`, `Read`, `Bash`), декомпозиция задачи и запуск волны из **3 параллельных субагентов** через `Agent`. | Все 3 субагента получают `workingDirectory = <home>/Desktop/test-zcode/new` и начинают одновременно писать и менять смежные файлы backend/frontend. | [`subagent/port.ts`](apps/zcode-cli/packages/core/src/runtime/methods/subagent/port.ts:555) |
| `16:10:42Z` – `16:14:18Z` | Субагенты `a44c3399` / `ae31523f` | Генерация крупных монолитных файлов UI/API через `Write` (`content` > 45–55 КБ вместе с reasoning-блоком). | Генерация обрывается ровно на лимите **`outputTokens = 16_384` (`finishReason = "length"`)**. Стриминг-парсер пытается выполнить `JSON.parse` незакрытой JSON-строки аргументов `Write` и падает с `SyntaxError: Unexpected end of JSON input` (`tool_input_invalid_json`). | Потолок `maxOutputTokens = 16384` + отсутствие перехвата `finishReason === "length"` до валидации JSON аргументов tool call. |
| `16:14:20Z` – `16:18:55Z` | Субагент после `invalid_json` | Повторная попытка записать тот же огромный файл целиком через `Write`, потому что сообщение об ошибке говорит лишь про невалидный JSON, **не сообщая модели, что сработал лимит `max_tokens`**. | Повторный удар в `16_384` выходных токенов, потеря ещё ~1.5–2 минут генерации и десятков тысяч токенов до тех пор, пока модель случайно не сокращает файл или не разбивает запись на `Write` + `Edit`. | Отсутствие специализированной диагностики `tool_call_truncated_by_max_tokens` в `call-runner.ts` / адаптере модели. |
| `16:16:05Z` – `16:22:40Z` | Параллельные субагенты `a44c3399`, `ae31523f`, `a90b79d4` | Одновременная запись и правка общих файлов (`backend/app/main.py`, `models.py`, `frontend/src/...`) инструментами `Write` и `Edit`. | **Гонка данных ФС:** субагент B перезаписывает через `Write` файл, созданный субагентом A секундой ранее, либо субагент A получает отказ `Edit`: `File has been modified since read, either by the user or by a linter`. | Отсутствие межсубагентного `FileLockRegistry` и git-worktree изоляции; `Write` не блокирует перезапись файла, не прочитанного в текущем `readFileState`, если он появился параллельно. |
| `16:20:11Z` – `16:28:49Z` | Субагенты и Main | Серия из **11 неудачных вызовов `Edit`** (`String to replace not found in file` и конфликт множественных вхождений `old_string`). | Модель `qwen3.6-plus` ошибается в отступах/пустых строках длинного `old_string`. Поскольку инструмент `ApplyPatch` отключён для всех не-GPT моделей, агент вынужден перечитывать файлы через `Read` целиком, раздувая контекст. | Узкий гейт `ApplyPatch` (только GPT) и отсутствие fuzzy/indent-tolerant/line-anchored сопоставления в `Edit`. |
| `16:26:00Z` – `16:33:13.681Z` | Main + финальная верификация `Bash` | Сборка и прогон тестов через `Bash`, исправление поломок после гонок субагентов, рост входного окна до **444 198 токенов**. | Каждый шаг на окне 300K–444K токенов пересылает весь контекст заново с **`cacheReadTokens: 0`**, замедляя TTFT и сжигая в сумме **20.47M input tokens** при отсутствии жёсткого observation masking старых `Read`/`Bash` выводов. | Отсутствие prompt-caching хинтов для OpenRouter/Qwen в `@ai-sdk/openai-compatible` и поздний порог autocompact от 1M окна (~800K). |

### 3.3. Доказанные корневые причины отказов (F-01 — F-07)

1. **F-01 — Слепота к обрыву генерации по `maxOutputTokens` (`finishReason === "length"`) при вызове инструментов:**  
   Когда модель генерирует одновременно `reasoning_content` и крупный JSON-аргумент `Write` / `Edit`, суммарный выход упирается в `16_384` токенов. Адаптер передаёт оборванный JSON в исполнитель инструментов, который фиксирует банальную ошибку парсинга `Unexpected end of JSON input` вместо явной инструкции модели: *«Вызов инструмента оборван по лимиту выходных токенов (16384). Не повторяй полный `Write` — создай каркас и допиши файл по частям»*. В результате модель повторяет ту же ошибку в цикле.
2. **F-02 — Разделяемая ФС в режиме Swarm без файловых блокировок и без worktree-изоляции:**  
   В [`subagent/port.ts`](apps/zcode-cli/packages/core/src/runtime/methods/subagent/port.ts:555) дочерние рантаймы получают общий `workspacePath` и разделяют карту чтения `sharedReadFileStateForChild` ([`runtime-reminders.ts`](apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts:288)), но **не имеют ни мьютексов на пути файлов, ни проверки владения файлами (ownership manifest), ни изолированных git worktrees**. Параллельные `Write`/`Edit` приводят к взаимному затиранию кода и каскаду ошибок `File has been modified since read`.
3. **F-03 — Хрупкость `Edit` и искусственная блокировка `ApplyPatch` для не-GPT моделей:**  
   Инструмент `ApplyPatch` (поддерживающий компактные многофайловые/многоханковые контекстные патчи) фильтруется по семейству модели и недоступен для `qwen`, `claude`, `deepseek`, `gemini`. При этом `Edit` требует практически побайтового совпадения `old_string` (нормализуются только хвостовые пробелы строк), из-за чего любая разница в 2 пробела отступа вызывает `String to replace not found` и вынуждает агент делать лишний `Read` + `Edit`.
4. **F-04 — Нулевое попадание в prompt cache (`cacheReadTokens = 0`) и гипертрофия контекста:**  
   На кастомном `openai-compatible` провайдере (OpenRouter `qwen/qwen3.6-plus`) не выставляются провайдер-специфичные заголовки/блоки `cache_control`, а при заявленном `contextWindow = 1_000_000` порог автокомпакции (~80%) не срабатывает даже на **444К токенов**, из-за чего сырые простыни `Read` и `Bash` таскаются в каждом из десятков ходов, умножая расход токенов на порядок.
5. **F-05 — Полное бездействие локального индекса кода (`CodeIndex`) в ходе сессии:**  
   Для Python-части проекта сканер [`scanner.ts`](packages/services/src/code-intelligence/scanner.ts:74) слеп (поддерживает только JS/TS), а для нового workspace индекс вообще не строится автоматически ([`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:183): `Never build a first index implicitly`). Поэтому агент тратил десятки вызовов `Bash`/`Glob`/`Read` вместо точечной навигации по символам.
6. **F-06 — Деградация наблюдаемости в сериализованном снимке `.zcode-session`:**  
   В экспортируемом `.zcode-session` отсутствуют явные поля `finishReason` (`length` vs `stop`) и первичные оборванные строки аргументов неудачных tool calls (`tool_input_invalid_json`), что без сопоставления с сырым `~/.zcode/cli/log/zcode-*.jsonl` скрывает от UI и инженеров истинную причину обрыва JSON.
7. **F-07 — Отсутствие синтаксической/AST верификации на границе записи файлов:**  
   Инструменты `Write` и `Edit` записывают текст на диск без быстрой проверки синтаксиса (Python AST / TypeScript parser / JSON parse), поэтому обрезанный импорт или синтаксический дефект обнаруживается только спустя много минут на финальном шаге `Bash`, когда уже накоплены конфликтующие правки других субагентов.

---

## 4. Аудит системных промптов, контекста, рассуждений и `Enhance Prompt` (Задача 2)

### 4.1. Архитектура системных промптов и режимов

- **Сборка системного промпта:** выполняется в `apps/zcode-cli/packages/core/src/prompt/` и рантайм-хелперах (`apps/zcode-cli/packages/core/src/runtime/`), а конфигурационные реестры базовых шаблонов фиксируются в [`config/prompts/registry.json`](config/prompts/registry.json:1) и [`config/prompts/baseline.json`](config/prompts/baseline.json:1).
- **Поддерживаемые режимы (`CollaborationMode` / permission modes):**
  1. `default` — стандартный агентный режим с запросом подтверждений на опасные операции.
  2. `acceptEdits` — автоодобрение файловых правок внутри workspace.
  3. `plan` — режим исследования и проектирования плана (блокирует деструктивные записи до `ExitPlanMode`).
  4. `guarded` / `auto` (`yolo`) — автоматическое исполнение с перехватом опасных bash-паттернов (`matchDangerousCommand` в [`bash.ts`](apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:160)).
  5. `coordinator` (`swarm`) — режим оркестратора роя субагентов (переключается кнопкой `Swarm` в композере [`ComposerControlNodes.tsx`](packages/ui/src/v4/conversation-composer/ComposerControlNodes.tsx:178)).
- **Измеренный объём системного промпта и деклараций инструментов (baseline):**
  - Базовый системный промпт + инструкции инструментов, git/env-контекст и правила Coordinator/Default составляют **~28 000 – 46 000 символов (~7 000 – 11 500 токенов)** на старте первого хода.
  - Декларации resident-инструментов (JSON Schema `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `CodeIndex`, `Agent`, `TodoWrite`, `ToolSearch`, `Skill` и др.) добавляют ещё **~24 000 – 36 000 символов (~6 000 – 9 000 токенов)**; таким образом, **минимальный холодный старт одного хода составляет ~14 000 – 20 500 токенов** ещё до первого слова пользователя.
  - Для снижения давления MCP и редких инструментов внедрён механизм `ToolSearch` / `DeferredToolCall` (`shouldDefer`), при этом [`CodeIndex`](apps/zcode-cli/packages/core/src/tool/handlers/code-index.ts:68) переведён в `alwaysLoad: true, shouldDefer: false`.

### 4.2. Слабые места промптов, бюджетирования контекста и `thinking`

1. **Полное отсутствие функции `Enhance Prompt` (улучшения пользовательского промпта):**  
   Поиск по всему монорепозиторию (`packages/ui`, `packages/services`, `packages/shared`, `apps/zcode-cli`) подтвердил **полное отсутствие (`0` вхождений)** какой-либо реализации `Enhance Prompt` — ни кнопки в [`ChatPromptEditor.tsx`](packages/ui/src/prompt-editor/ChatPromptEditor.tsx:40) / [`V4ComposerToolbar.tsx`](packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1), ни RPC-канала в `packages/shared`, ни сервиса переписывания/обогащения запроса с учётом контекста репозитория.
2. **Привязка бюджетирования к номинальному `contextWindow` без учёта деградации внимания и цены:**  
   На моделях с окном `1_000_000` токенов (`qwen3.6-plus`, `gemini`, `claude-sonnet-4` 1M) автокомпакция ждёт заполнения ~80% окна, позволяя контексту бесконтрольно пухнуть до 300K–500K токенов из-за старых выводов `Read`/`Bash`/`Grep`.
3. **Уязвимости передачи `thinking` / `reasoningEffort`:**  
   В UI уровень рассуждений выбирается через [`ThoughtLevelCycleControl.tsx`](packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx:26) и передаётся с очередным `Submission`. В адаптерах (`patches/@ai-sdk__anthropic@3.0.81.patch`, `patches/@ai-sdk__openai-compatible@2.0.60.patch`) параметры маппятся в `thinking.budget_tokens` (Anthropic) или `reasoning_effort` (OpenAI/compatible), однако **бюджет `maxOutputTokens` не масштабируется автоматически на величину `thinking`**, из-за чего длинное рассуждение съедает квоту `16_384` выходных токенов и обрывает JSON аргументов вызываемого следом инструмента (корень сбоя **F-01**!).

---

## 5. Аудит редактирования файлов, фоновых задач и синхронизации с UI (Задача 3)

### 5.1. Инструменты работы с файлами (`Read`, `Write`, `Edit`, `ApplyPatch`)

| Критерий аудита | Фактическое состояние в коде Zcode | Архитектурный риск / Дефект |
| --- | --- | --- |
| **Чтение (`Read`)** | Поддерживает `offset` / `limit`, кэш прочитанных диапазонов `ReadFileStateMap`, защиту границ [`resolveWorkspacePath`](apps/zcode-cli/packages/core/src/tool/path-policy.ts:1). | Выводы `Read` остаются в истории сообщений в полном виде многие десятки ходов без автоматического сворачивания устаревших версий одного и того же файла. |
| **Точечная правка (`Edit`)** | Строковая замена `old_string` → `new_string` (`replace_all`), проверка `mtime` относительно `readFileState`. | Нет fuzzy/anchor/indent-tolerant поиска блока; малейший сдвиг пробелов ломает вызов (11 сбоев в исследуемой сессии). |
| **Патчинг (`ApplyPatch`)** | Реализован в `apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts`, поддерживает добавление, удаление и многоханковое изменение файлов. | Искусственно ограничен по семейству моделей (включён для GPT, скрыт от Qwen/Claude/Gemini/DeepSeek), хотя формат компактных ханков радикально снижает расход выходных токенов и риск обрыва `maxOutputTokens`. |
| **Мультифайловые транзакции и откаты** | Каждая операция `Write`/`Edit` пишет напрямую в рабочее дерево. Артефакты до/после сохраняются в `cli/artifacts/<sess>/` для UI-просмотра и ручного rewind (`cold-file-change-summaries.ts`). | **Нет атомарных мультифайловых транзакций** на уровне пакета правок и **нет блокировок файлов** между параллельными субагентами. |
| **AST / синтаксическая валидация** | **Отсутствует** при выполнении `Write` / `Edit` / `ApplyPatch`. | Сломанный синтаксис (незакрытая скобка, конфликт импортов) тихо сохраняется на диск без мгновенной обратной связи в tool result. |

### 5.2. Фоновые задачи, `CommandInbox` и реактивная синхронизация с UI

- **`CommandInbox`:** Входящие сообщения пользователя во время активного хода (`busy`/`running`) сериализуются на стороне `AgentRuntime` (`CommandInbox`), в то время как Renderer (`packages/ui`) хранит только неотправленный черновик (`composerDraftStore`) и оптимистичный pending-оверлей.
- **Фоновые команды и субагенты:** [`bash.ts`](apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:250) поддерживает `run_in_background` (`explicit` и `auto_on_timeout`), а субагенты управляются через `runtimeTaskRegistry` и отображаются в композере через `ConversationBackgroundWorkTrigger`. Однако глобальный лимит параллелизма субагентов не координирует доступ к файлам.
- **Синхронизация диффов и ФС с Desktop и Web:**  
  - На Desktop действует непрерывный поток событий `desktop-continuous` через `TaskRealtimeBus` в Electron Main; сводки изменений файлов агрегируются из tool-артефактов в `MessageChangeSummaryPanel.tsx` и `GitPane.tsx`.
  - Для Mobile/Web Remote используется отдельный контракт `web-remote-replayable` со снимками с ограниченным байтовым бюджетом (`docs/web-remote-control/snapshot-byte-budget.md`).

---

## 6. Инструментальный аудит и базовые метрики кодового индекса и поиска (Задача 4)

### 6.1. Фактическая архитектура индексации и поиска в Zcode

В Zcode сосуществуют три контура поиска:
1. **`Grep`** ([`grep.ts`](apps/zcode-cli/packages/core/src/tool/handlers/grep.ts:36)) — обёртка над `@vscode/ripgrep` через `FileSystemPort.searchText` (лимит выдачи в модель `20_000` байт, таймаут `30 с`).
2. **`Glob`** ([`glob.ts`](apps/zcode-cli/packages/core/src/tool/handlers/glob.ts:29)) — поиск путей через `FileSystemPort.searchFiles` (до `100` файлов, сортировка по `mtime`).
3. **`CodeIntelligenceService` + инструмент `CodeIndex` + `buildCodeIndexTurnHint`:**
   - Сервис живёт в Local Host: [`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:78), сканер — [`scanner.ts`](packages/services/src/code-intelligence/scanner.ts:438), БД на встроенном `node:sqlite` (`DatabaseSync`) — [`database.ts`](packages/services/src/code-intelligence/database.ts:22), файловый наблюдатель — [`workspaceWatcher.ts`](packages/services/src/code-intelligence/workspaceWatcher.ts:32), графовые запросы — [`graphReads.ts`](packages/services/src/code-intelligence/graphReads.ts:79).
   - Агент обращается к нему двумя путями: явно через resident-инструмент [`CodeIndex`](apps/zcode-cli/packages/core/src/tool/handlers/code-index.ts:46) (`status`, `search`, `context`, `impact`, `trace`, бюджет `24_000` байт) и неявно на старте каждого пользовательского хода через [`buildCodeIndexTurnHint`](apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts:304) (таймаут `2_000 мс`, `4` хита, `lexicalOnly: true`, бюджет `12_000` символов).

### 6.2. Доказанные критические дефекты подсистемы `code-intelligence`

1. **Первичный индекс никогда не создаётся автоматически (`unindexed` по умолчанию):**  
   В [`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:183) жёстко заложено правило:
   ```ts
   // Never build a first index implicitly.
   if (status.generation > 0) await indexWorkspace(params);
   ```
   Пока пользователь вручную не откроет [`CodeIndexPopover.tsx`](packages/ui/src/agent-workbench/CodeIndexPopover.tsx:94) или [`AgentWorkbenchView.tsx`](packages/ui/src/agent-workbench/AgentWorkbenchView.tsx:130) и не нажмёт кнопку построения индекса, `status.state === "unindexed"`, `buildCodeIndexTurnHint` возвращает `null`, а read-only инструмент `CodeIndex` бесполезен.
2. **Полная слепота ко всем языкам, кроме JS/TS (отсутствие Tree-sitter):**  
   В [`scanner.ts`](packages/services/src/code-intelligence/scanner.ts:74) индексируются исключительно `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` через `ts.createSourceFile`. Проекты на Python, Rust, Go, Java, C/C++, C#, SQL, Markdown, YAML дают **`0` файлов и `0` чанков**, при этом БД сохраняет `index_state = "ready", index_partial = "false"` (что подтверждено реальным файлом `~/.zcode/code-intelligence/e5c2b610f780d4e4d2df7218095d7f1c.sqlite3` на машине разработчика: `state: ready` при `counts: { files: 0, chunks: 0, symbols: 0, edges: 0 }`!).
3. **Катастрофический дефект лексического поиска: `LIKE '%...%' OR ... LIMIT 1001` без `FTS5` / BM25 и без `ORDER BY`:**  
   Хотя проверка бинарника Node 24 показала, что **`FTS5` уже скомпилирован и доступен в `node:sqlite` (`fts5Supported: true`)**, схема [`database.ts`](packages/services/src/code-intelligence/database.ts:22) не использует `FTS5`! Вместо этого [`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:629) выполняет:
   ```sql
   SELECT id, path, start_line, end_line, content FROM chunks
   WHERE content LIKE '%t1%' OR content LIKE '%t2%' ... LIMIT 1001
   ```
   На любом запросе из 2+ слов SQLite делает последовательный full-table scan в алфавитном порядке вставки путей (`.agents/skills/**` → `apps/dev-docs/**` → `apps/zcode-cli/e2e/**`), набирает первые `1000` случайных чанков, где встретилось хотя бы одно частое слово, и **отбрасывает всю остальную кодовую базу** (`packages/services/**`, `packages/ui/**` и т.д.)! Затем эти 1000 случайных кандидатов оцениваются примитивной формулой [`lexicalScore`](packages/services/src/code-intelligence/database.ts:121) (`matched / queryTerms.length` через подстрочный `includes` без IDF, без длины документа и без границ слов).
4. **Зашумление индекса тестами и фикстурами (39.4% базы) и наивная нарезка чанков по строкам:**  
   В реальном индексе Zcode (`11 725` файлов) **4 616 файлов (`39.4%`)** — это тесты, E2E-фикстуры и скрипты скиллов, которые никак не пенализируются при ранжировании и вытесняют продакшн-код из топ-4/топ-12. Чанки в [`makeChunks`](packages/services/src/code-intelligence/scanner.ts:187) режутся фиксированным окном по `120` строк с перекрытием `12` строк без привязки к границам AST-узлов.
5. **Раздутие SQLite до 527.40 МБ без единого вектора и синхронная блокировка Local Host:**  
   Реальная БД индекса Zcode `~/.zcode/code-intelligence/3dc98f7e14341f3b074b0f3bd86eb562.sqlite3` (`generation = 402`, `embeddedChunks = 0`) занимает **527.40 МБ** на диске (`135 015` страниц по 4 КБ), потому что в `symbols`, `edges` (`378 802` строк) и `imported_calls` (`50 371` строк) первичные и внешние ключи хранятся как длинные текстовые строки `s:<full/relative/path>:<line>:<kind>:<name>` с дублированием в нескольких B-tree индексах. При этом [`withDb`](packages/services/src/code-intelligence/codeIntelligenceService.ts:124) открывает и закрывает синхронный `DatabaseSync` на каждый запрос, блокируя event loop Local Host на `30–311 мс`, а семантический поиск в [`mergeSemanticChunkHits`](packages/services/src/code-intelligence/graphReads.ts:288) вычитывает все BLOB-векторы в JS и сортирует массив внутри цикла.
6. **Повреждение JSON-ответа инструмента `CodeIndex` жёстким `truncate` на 24 000 байтах:**  
   [`formatCodeIndexResult`](apps/zcode-cli/packages/core/src/tool/handlers/code-index.ts:38) возвращает `JSON.stringify(output, null, 2)` средним размером **`45 716` символов (~46 КБ)** при `limit = 12`, после чего `resultBudget` (`maxModelBytes: 24_000, strategy: "truncate"`) режет строку прямо посередине JSON-объекта, отдавая модели невалидный обрубок JSON и отсекая нижнюю половину результатов.
7. **Проблема `fs.watch({ recursive: true })` на Linux и тяжёлый инкрементальный проход:**  
   В [`workspaceWatcher.ts`](packages/services/src/code-intelligence/workspaceWatcher.ts:80) вызов `watch(root, { recursive: true })` на Linux вешает inotify-дескрипторы на все каталоги внутри `node_modules` и `.git` (фильтр `shouldRefresh` работает уже в JS-колбэке), а каждое срабатывание дебаунса (`300 мс`) запускает полный `readdir`+`stat` всего дерева и полное удаление/перестроение всех межфайловых `calls`-рёбер SQLite ([`codeIntelligenceService.ts`](packages/services/src/code-intelligence/codeIntelligenceService.ts:487)).

### 6.3. Измеренные baseline-метрики индексации и памяти

Замеры выполнены инструментально на рабочей машине (`Node v24`, `--expose-gc`, `nice -n 19`) через реальный [`createCodeIntelligenceService`](packages/services/src/code-intelligence/codeIntelligenceService.ts:78) и реальную базу индекса монорепозитория Zcode:

| Метрика | Полный монорепозиторий Zcode (фактический индекс на диске) | Пакет `packages/services` (изолированный бенчмарк Cold/No-op) | Пакет `packages/rpc/src` (5 циклов мутации 1 файла) |
| --- | --- | --- | --- |
| **Файлов в индексе (`counts.files`)** | `11 725` (из них `4 616` / `39.4%` — тесты и фикстуры) | `1 191` | `16` |
| **Чанков / Символов / Рёбер** | `28 353` / `283 700` / `378 802` | `3 103` / `34 025` / `45 800` | `42` / `544` / `609` |
| **Размер SQLite БД на диске (без эмбеддингов)** | **`527.40 МБ`** (`553 021 440` байт) | **`48.10 МБ`** (~40.4 КБ / файл) | `< 1 МБ` |
| **Время первичной индексации (Cold Build)** | ~`16–20 с` (экстраполяция линейного AST+SQLite прохода) | **`1 664.75 мс`** | `< 60 мс` |
| **Время холостого инкрементального прохода (0 изм.)** | ~`900–1 100 мс` | **`93.61 мс`** | `< 10 мс` |
| **Время инкрементального обновления (1 файл изм.)** | Зависит от числа файлов (`O(N_files + N_imported_calls)`) | ~`105–130 мс` | **`11.19 – 14.69 мс`** (средн. `12.84 мс`) |
| **Потребление JS Heap (до / после GC)** | — | `61.14 МБ` → **`70.13 МБ`** (`RSS = 371.62 МБ`) | Серия после GC: `69.35, 69.28, 69.33, 69.30, 69.32 МБ` (**утечек JS Heap нет**) |

### 6.4. Измеренные baseline-метрики качества и скорости поиска (10 контрольных запросов по Zcode)

Контрольный прогон выполнен по реальному индексу монорепозитория Zcode (`11 725` файлов, `28 353` чанков, `283 700` символов; во всех 10 запросах целевые продакшн-файлы присутствуют в таблице `files` индекса, `gtCount >= 1`):

| ID | Тип | Поисковый запрос | Целевой модуль (Ground Truth) | Latency (мс) | `partial` (`>1000` канд.) | Ранг GT (`rank@12`) | Фактический Top-1 в выдаче Zcode | Сырой ответ `CodeIndex` (симв. / ~ток.) |
| --- | --- | --- | --- | ---: | :---: | :---: | --- | ---: |
| **Q1** | NL arch | `session compaction token budget threshold` | `apps/zcode-cli/packages/core/src/compact/*` (`12` файлов) | `43.61` | `true` | **MISS** (`null`) | `.agents/skills/zcode-large-task-fixture/.../generate-large-task-fixture.mjs:109` | `49 049` / `12 263` |
| **Q2** | NL tool | `apply patch unified diff hunk parser` | `.../core/src/tool/handlers/apply-patch.ts` (`1` файл) | `100.34` | `true` | **`12`** | `apps/zcode-cli/packages/tui/src/app-tool-diff-display.ts:41` | `44 139` / `11 035` |
| **Q3** | NL service | `workspace file watcher recursive debounce` | `packages/services/src/code-intelligence/workspaceWatcher.ts` (`1` файл) | `29.93` | `true` | **MISS** (`null`) | `apps/dev-docs/vite.config.ts:58` | `49 110` / `12 278` |
| **Q4** | NL provider | `anthropic prompt cache control ephemeral` | `apps/zcode-cli/packages/adapters/src/model/*` (`75` файлов) | `59.38` | `true` | **`9`** | `.../adapters/tests/anthropic-mid-conversation-system-wire.test.ts:1` | `44 470` / `11 118` |
| **Q5** | NL subagent | `subagent parallel concurrency limit max` | `.../core/src/runtime/methods/subagent/*` (`10` файлов) | `51.02` | `true` | **MISS** (`null`) | `.../bootstrap/src/app/dynamic-workflow-run-launch.ts:109` | `51 130` / `12 783` |
| **Q6** | NL protocol | `stdio jsonrpc agent protocol request handler` | `packages/shared/src/zcode-protocol/*`, `zcode-agent/*` (`292` файла) | `34.90` | `true` | **MISS** (`null`) | `apps/dev-docs/src/data/protocol-docs/stdio-traffic.ts:1` | `45 148` / `11 287` |
| **Q7** | Exact symbol | `createCodeIntelligenceService` | `.../code-intelligence/codeIntelligenceService.ts` (`1` файл) | `96.69` | `false` | **`1`** | `packages/services/src/code-intelligence/codeIntelligenceService.ts:78` | `53 635` / `13 409` |
| **Q8** | Exact symbol | `buildCodeIndexTurnHint` | `.../core/src/runtime/helpers/runtime-reminders.ts` (`1` файл) | `59.98` | `false` | **`1`** | `.../core/src/runtime/helpers/runtime-reminders.ts:304` | `28 198` / `7 050` |
| **Q9** | Hybrid | `EmbeddingProviderSettings ollama endpoint apiKey` | `packages/ui/src/agent-workbench/EmbeddingProviderSettings.tsx` (`1` файл) | `311.24` | `true` | **MISS** (`null`) | `packages/services/src/code-intelligence/codeIntelligenceService.ts:541` | `44 115` / `11 029` |
| **Q10** | Hybrid | `resolveWorkspacePath boundary symlink traversal` | `apps/zcode-cli/packages/core/src/tool/path-policy.ts` (`1` файл) | `285.50` | `true` | **`5`** | `.../core/tests/path-policy-workspace-boundary.test.ts:1` | `48 170` / `12 043` |

**Агрегированные baseline-показатели поиска Zcode:**
- **`Recall@4` (окно автоматической подсказки `buildCodeIndexTurnHint`):** **`0.20` (20%)** — на **0 из 8** многословных NL/гибридных запросов целевой продакшн-файл попадает в подсказку хода, зато в ход впрыскивается `12 000` символов (`~3 000` токенов) нерелевантных тестов и фикстур!
- **`Recall@5`:** **`0.30` (30%)**.
- **`Recall@12` (полное окно инструмента `CodeIndex` до обрезки 24 КБ):** **`0.50` (50%)** (а с учётом байтового `truncate` на 24 КБ хиты с рангами 7–12 в Q2 и Q4 физически отрезаются от модели, снижая эффективный `Recall` модели до **`0.30`!**).
- **`MRR@12`:** **`0.2394`**.
- **Доля усечённых по `LIMIT 1001` запросов (`partial: true`):** **`80%`** (`8` из `10`).
- **Средняя задержка (блокирующая поток Host):** **`107.26 мс`** (на гибридных запросах до **`311.24 мс`**).
- **Средний объём ответа `CodeIndex` до обрезки:** **`45 716` символов (`~11 430` токенов)** → после жёсткого `truncate` ровно `24 000` байт (`~6 000` токенов) с битым JSON.

---

## 7. Аудит Computer Use, Browser Use и среды исполнения (Задача 5)

Сопоставление проектной карты [`docs/product-capability-map-office-computer-use.md`](docs/product-capability-map-office-computer-use.md:14) с фактическим кодом выявило следующие границы и разрывы:

1. **Отсутствие OS-песочницы для `Bash` (`not_implemented`):**  
   В [`bash.ts`](apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:92) явно зафиксировано `const BASH_SANDBOX_ENFORCEMENT = "not_implemented"`. Ни `sandbox-exec` (Seatbelt) на macOS, ни `bubblewrap` / `seccomp` / user namespaces на Linux не применяются. Защита ограничивается статической проверкой командной строки `assertBashCommandPathBoundary` и эвристиками `matchDangerousCommand`, которые не контролируют дочерние процессы внутри запущенного Python/Node/Makefile скрипта.
2. **Изоляция PTY от агента:**  
   Настоящий псевдотерминал `node-pty` существует только в [`terminalService.ts`](packages/services/src/terminal/terminalService.ts:30) для визуальной панели терминала пользователя в UI (`Terminal.tsx`). Сам агент исполняет команды через неинтерактивный [`NodeExecutionAdapter`](apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter.ts:5) (`child_process.spawn`), не имея инструментов интерактивного управления PTY-сессией (`write_stdin` / `poll_pty`) для REPL, дебаггеров или интерактивных CLI-визардов.
3. **Desktop Computer Use полностью отключён на Linux:**  
   В [`shouldEnableDefaultCuaProductHelper`](packages/services/src/node/cua-helpers.ts:54) стоит жёсткая проверка `return platform === "darwin" || platform === "win32"`. На Linux ни захват экрана рабочего стола, ни ввод мыши/клавиатуры (`xdotool`/`ydotool`/`at-spi`/Wayland portal), ни панель управления/перехвата (human takeover) не реализованы.
4. **Высокие накладные расходы stateless `mcp__node_repl__js` для Browser Use / Playwright и разомкнутый контур самовосстановления:**  
   Браузерная автоматизация ([`browser-control.port.ts`](apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts:16), [`control-browser/SKILL.md`](apps/zcode-cli/packages/browser-use-plugin/skills/control-browser/SKILL.md:14)) поддерживает `iab` (встроенный Electron `WebContentsView`), `cdp` (headless Chromium) и `extension`, включая компактный ARIA `domSnapshot()`, локаторы Playwright, скриншоты и запись `.webm`. Однако:
   - Каждый вызов `mcp__node_repl__js` выполняется в **полностью обнуляемом JS-ядре**, заставляя модель в каждой ячейке заново писать 12 строк динамического `import(browserClientUrl)` и тратить отдельные ходы на `tabs.list()` → `tabs.get(id)` → действие.
   - **Отсутствует автоматический контур обратной связи по ошибкам рантайма приложения:** ошибки `console.error`, `pageerror` (uncaught exceptions React/Vite), неуспешные сетевые ответы (`HTTP 4xx/5xx`, CORS) и логи запущенного dev-сервера не агрегируются автоматически в наблюдение после действия — если страница отрендерила пустой экран или тихо упал запрос, модель не видит стектрейс без ручной отладки.

---

## 8. Аудит UI поля ввода чата (`Composer`) и системы настроек (`Settings`) (Задача 7)

### 8.1. Композер чата (`ConversationComposer` / `LexicalChatInput`)

- **Цепочка рендеринга:** [`ConversationComposer.tsx`](packages/ui/src/v4/ConversationComposer.tsx:100) → [`ChatPromptEditor.tsx`](packages/ui/src/prompt-editor/ChatPromptEditor.tsx:40) → [`LexicalChatInput.tsx`](packages/ui/src/LexicalChatInput.tsx:48) (на базе `@lexical/react` с кастомной нодой `PromptMentionNode`).
- **Система триггеров и slash-команд:**
  - [`SlashCommandPlugin.tsx`](packages/ui/src/SlashCommandPlugin.tsx:60) и [`slashCommandHelpers.ts`](packages/ui/src/slashCommandHelpers.ts:46) объединяют в единой всплывающей панели `/` три источника с единым нечётким ранжированием (`getBestPromptInputSuggestionIndex`): команды каталога CLI (`ZCodeSlashCommand`), локальные UI-команды приложения (`AppSlashCommand`, например `/side`), активные скиллы (`$skill`) и профили субагентов.
  - `MentionPlugin` обслуживает триггеры `@` (файлы рабочего пространства, плагины, whiteboard), `#` (ссылки на сессии) и drag-and-drop файлов из дерева проекта.
- **Тулбар композера ([`ComposerControlNodes.tsx`](packages/ui/src/v4/conversation-composer/ComposerControlNodes.tsx:83), [`V4ComposerModelControlsView.tsx`](packages/ui/src/v4/composer/composer-toolbar/V4ComposerModelControlsView.tsx:30)):**
  - Левый кластер: меню `+` (`ChatPromptActionMenu`), переключатель режима (`V4ComposerModeSwitch`), кнопка Computer Use (`V4ComposerCuaEntry`), индикатор фоновых задач (`ConversationBackgroundWorkTrigger`).
  - Правый кластер: круговой индикатор контекста и сжатия (`ChatContextUsage`), поповер индекса кода ([`CodeIndexPopover`](packages/ui/src/agent-workbench/CodeIndexPopover.tsx:18)), селектор модели (`ModelConfigSelect`), селектор глубины мышления ([`ThoughtLevelCycleControl`](packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx:26)), переключатель роя (`Swarm`) и кнопка `Send`/`Stop`.
  - **Отсутствующие элементы UX:** полностью отсутствует кнопка/хоткей **`Enhance Prompt`** (предпросмотр/откат улучшенного промпта с инъекцией релевантного контекста проекта), а также отсутствует автоматическое фоновое построение индекса кода при открытии проекта (индикатор `CodeIndexPopover` висит в состоянии `unindexed` до ручного клика).

### 8.2. Архитектура `SettingsPage` и раскол хранения настроек

- **Витрина настроек ([`SettingsPage.tsx`](packages/ui/src/SettingsPage.tsx:29), [`SettingsSectionContent.tsx`](packages/ui/src/settings-page/SettingsSectionContent.tsx:55)):** содержит 17 специализированных разделов (`general`, `remoteDevices`, `appearance`, `shortcuts`, `modelProvider` вкл. подраздел `Embeddings`, `memory`, `plugin`, `mcp`, `skill`, `migration`, `archives`, `codeGraph`, `usage`, `subagents`, `automations`, `commands`, `hooks`, `workspaceFileSearch`, `browser`, `computerUse`).
- **Двойной источник истины на диске (App `v2` vs CLI `cli`):**
  1. Сервисы Host (`ISettingService`, [`settingService.ts`](packages/services/src/setting/settingService.ts:240)) атомарно хранят `AppSettings` в **`~/.zcode/v2/setting.json`** (с защитой от гонок записи и карантином битых файлов `.corrupt-*`), а секреты API-ключей — в `ICredentialService`.
  2. Агентный рантайм `zcode-cli` хранит собственную конфигурацию в **`~/.zcode/cli/config.json`** и БД сессий в **`~/.zcode/cli/db/db.sqlite`**. Как задокументировано в [`docs/settings-storage-management.md`](docs/settings-storage-management.md:22), смена `dataBaseDir` в UI переносит только `.zcode/v2`, оставляя `.zcode/cli` в домашнем каталоге пользователя, а часть настроек пробрасывается из Host в CLI только при старте/обновлении сессии по протоколу, создавая риск рассинхронизации между standalone CLI и Desktop UI.

---

## 9. Сводная матрица приоритетов модернизации для последующих этапов

| Приоритет | Подсистема | Целевое архитектурное изменение по итогам аудита Этапа 1 |
| --- | --- | --- |
| **P0** | Агентный цикл и Tool Runner (`apps/zcode-cli`) | Детектирование `finishReason === "length"` до парсинга JSON аргументов инструментов с возвратом специализированной инструкции восстановления; автоматический резерв выходного бюджета под `thinking` + аргументы инструментов. |
| **P0** | Оркестрация субагентов и ФС (`subagent`, `Write`, `Edit`, `ApplyPatch`) | Межсубагентный реестр файловых блокировок (`FileLockRegistry`) / проверка владения файлами в Swarm, опциональная git-worktree изоляция, разблокировка `ApplyPatch` для всех сильных coding-моделей (Qwen/Claude/DeepSeek/Gemini), добавление indent/fuzzy-anchor сопоставления в `Edit` и быстрой синтаксической/AST проверки после записи. |
| **P0** | Кодовый индекс и поиск (`packages/services/src/code-intelligence`) | Включение встроенного в `node:sqlite` индекса **FTS5 (BM25)** вместо `LIKE '%...%' LIMIT 1001`, дедупликация/пенализация тестовых и фикстурных путей, переход на целочисленные ID узлов в `symbols`/`edges` (сокращение БД с 527 МБ в 5–8 раз), замена `strategy: "truncate"` на структурную обрезку по элементам массива, автозапуск фоновой первичной индексации и расширение языков через Tree-sitter / мультиязычный сканер (Python, Rust, Go, MD и др.). |
| **P1** | Управление контекстом и Prompt Caching (`core/compact`, `adapters/model`) | Поддержка кэширования промптов для OpenRouter / совместимых провайдеров, агрессивный observation masking устаревших больших выводов `Read`/`Bash`/`Grep` задолго до заполнения окна 1M токенов. |
| **P1** | UI композера и `Enhance Prompt` (`packages/ui`, `packages/services`) | Реализация сквозной функции `Enhance Prompt` в тулбаре композера (сбор легковесного контекста репозитория/индекса + потоковое улучшение промпта с возможностью `Undo`/отмены) и настроек модели для улучшения в `SettingsPage`. |
| **P2** | Computer Use и среда исполнения (`exec`, `browser-use`, Linux CUA) | Автоматический сбор `console.error`/`pageerror`/сетевых сбоев в наблюдения Browser Use, кэшированная сессия SDK вместо холодного импорта в каждом `mcp__node_repl__js`, поддержка интерактивного PTY-инструмента для агента и проектирование Linux-адаптера песочницы (`bubblewrap`) / CUA. |
