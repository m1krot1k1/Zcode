# GitNexus и графы кода: исследование и сверка с CodeIndex Zcode

Дата: 2026-11-19. Ветка: `dev`. Репозиторий: `/home/ndppd/Desktop/git/Zcode`.
Метод: веб-источники (URL и дата обращения указаны в разделе «Источники»), затем сверка с текущим
исходным кодом Zcode. Факты из источников помечены как **[источник]**, выводы и оценки — **[вывод]**.
Где источник недоступен или утверждение не проверено — `unknown`.

## 1. Контекст и метод

Задача: оценить, нужен ли Zcode внешний граф кода GitNexus и какие технологии из класса
«графы кода / MCP / LSP / tree-sitter / песочницы / ранжирование контекста» стоит рассматривать,
а также что уже реализовано в Zcode.

Что проверено фактически:

- Исходники GitNexus: README, LICENSE, `package.json`, npm-метаданные, `docs/mcp-reference.md`,
  `docs/cli-reference.md`, `SECURITY.md`, `ARCHITECTURE.md`, sparse-клон `gitnexus/src`.
- Метаданные GitHub API (stars, pushed_at, license) для GitNexus и сравнения.
- Исходный код Zcode: `packages/services/src/code-intelligence/**`,
  `apps/zcode-cli/packages/adapters/src/mcp/**`, `apps/zcode-cli/packages/core/src/mcp/**`,
  `packages/services/src/mcp-sync/**`, `packages/shared/src/mcp.ts`,
  `packages/shared/src/stage4-settings/settings.ts`, плагины и терминал.
- Точечные проверки: см. раздел 9. Полный `pnpm test` / сборка не запускались (задача research-only).

Ограничения: сравнение не является бенчмарком на одном корпусе; цифры Zcode взяты из уже
существующего внутреннего бенчмарка (`docs/architecture/stage4-3-code-intelligence-benchmark.md`),
а не измерены заново. Оценки стоимости интеграции — экспертные, не смета.

## 2. Краткий вывод

- **GitNexus** — зрелый по активности, но молодой по версии (npm `1.6.12`, ежедневные RC) локальный
  граф кода на TypeScript с MCP-сервером и шестью инструментами. Лицензия —
  **PolyForm Noncommercial 1.0.0**: коммерческое использование требует отдельной лицензии.
  Установка тяжёлая (230.6 МБ unpacked, нативные зависимости), Node `^22.18.0 || >=24.11.0`,
  а `analyze` по умолчанию может ставить расширения LadybugDB из сети и пишет файлы в репозиторий
  (`AGENTS.md`, `.claude/skills`, `.gitnexus/`).
- **Zcode уже имеет** собственный локальный tree-sitter/SQLite-индекс с FTS5, PageRank, RRF-слиянием
  четырёх каналов, token-budget упаковкой и MCP-инфраструктурой. По внутреннему бенчмарку:
  Recall@4 0.9167, Recall@12 1.0000, MRR@12 0.8889, p50 29.3 мс, p95 56.3 мс.
- **Решение: не интегрировать GitNexus** ни как встроенный индекс, ни как запись статического
  каталога MCP-пресетов на этом этапе. Причины: noncommercial-лицензия, непредставимые в схеме
  каталога предусловия (Node, `gitnexus analyze`, 230 МБ, запись в репозиторий), конфликт с
  требованием «выключено по умолчанию» (серверы в Zcode по умолчанию `enabled`, если поле не задано),
  и дублирование уже работающего CodeIndex. Рекомендуемая форма записи на будущее — в разделе 7.
- Приоритетные направления для Zcode: (P0) сохранить CodeIndex единственным владельцем локального
  индекса и привести `CONTRACT.md` в соответствие со схемой v4; (P1) опциональный импорт SCIP,
  поддержка LSP-компонентов плагинов, песочница для stdio MCP; (P2) расширение грамматик,
  внешние сканеры (Semgrep CE) как плагины, без встраивания CodeQL/Glean/Kythe/Firecracker.

## 3. GitNexus: детальный разбор

### 3.1 Что это и зрелость

- Репозиторий: `https://github.com/abhigyanpatwari/GitNexus`, язык TypeScript,
  создан 2025-08-02, на 2026-11-19: **48 657 stars**, `pushed_at = 2026-11-19T…`,
  теги `v1.6.13-rc.241` (2026-11-19), npm latest **1.6.12**. **[источник: GitHub API, npm]**
- Позиционирование: локальный граф кода с индексацией без LLM, MCP-сервер, CLI `analyze/setup/mcp`,
  веб-UI. Есть режим `--http` для MCP; по умолчанию — stdio. **[источник: gitnexus/README.md]**
- MCP-инструменты (исходник `gitnexus/src/mcp/tools.ts`):
  `query` (:175), `context` (:356), `detect_changes` (:448), `rename` (:527), `impact` (:554),
  `trace` (:976). **[источник]**
- Версионная зрелость: большое число RC-тегов в день (241-й RC), npm-версия отстаёт от тегов.
  Это признак высокой активности, но не «стабильного API». **[вывод]**

### 3.2 Лицензия

- `gitnexus/package.json` и npm: `"license": "PolyForm-Noncommercial-1.0.0"`.
  GitHub API отдаёт `NOASSERTION` (кастомный текст). В README указана коммерческая лицензия
  через Akon Labs. **[источник: LICENSE, gitnexus/package.json, npm registry, README]**
- Практический вывод: **нельзя** включать GitNexus в поставку Zcode или предлагать его как
  безусловно бесплатный пресет коммерческого продукта без юридической проверки и явного
  раскрытия лицензии в UI. **[вывод]**

### 3.3 Требования и стоимость установки

- Node: `^22.18.0 || >=24.11.0` (npm `engines`). Это уже ограничение: Node 24.0–24.10 и 22.0–22.17
  не подходят. **[источник: npm]**
- npm tarball: **230 595 342 байт unpacked, 2 374 файла**. Зависимости включают
  `@ladybugdb/core`, `tree-sitter` + грамматики C/C++/Go/Java/PHP/Python/Ruby/Rust/C#/JS/TS,
  `graphology`, `express`, `onnxruntime-common`; опционально `onnxruntime-node`,
  `@huggingface/transformers`. **[источник: npm]**
- README предупреждает о падении `npx` под npm 11 — для пресета нужен либо npm 10, либо
  предварительная глобальная установка. **[источник: gitnexus/README.md]**
- `analyze` по умолчанию может один раз поставить расширения LadybugDB из сети; `GITNEXUS_LBUG_EXTENSION_INSTALL=never`
  отключает это. MCP/`serve` используют `load-only` и не ставят расширения. **[источник: docs/cli-reference.md]**
- `analyze` пишет в проект: секцию в `AGENTS.md`/`CLAUDE.md`, `.claude/skills/gitnexus-*`,
  `.gitnexus/`, `setup` — хуки. Это важно для «тихого» подключения к чужому репозиторию. **[источник: README]**
- Проверка обновлений: не чаще раза в 24 часа, пропускается для npx-кэша и CI. **[источник: gitnexus/README.md]**

### 3.4 Безопасность и приватность

- Индексация локальная, без LLM; remote embeddings/wiki/chat — только при явной настройке провайдера.
  Публикация в реестр — opt-in с токеном. **[источник: README, SECURITY.md]**
- `@scarf/scarf` объявлен в зависимостях npm. В sparse-клоне `gitnexus/src` и `gitnexus/scripts`
  импортов/упоминаний `scarf` не найдено; считать его активную телеметрию доказанной нельзя.
  **unknown**: поведение опубликованного бандла и транзитивных зависимостей не аудировалось. **[источник + вывод]**
- Риски: сторонний код с широкими сетевыми зависимостями, нативные бинарники, запись файлов в
  репозиторий, noncommercial-лицензия. Для приватного кода — локальный индекс остаётся локальным,
  но это свойство надо проверять на конкретной версии, а не принимать на веру. **[вывод]**

### 3.5 Польза для Zcode

- Плюсы GitNexus: межфайловый граф, impact/trace/rename/detect_changes, MCP «из коробки»,
  мультиязычность (C/C++, Go, Java, PHP, Python, Ruby, Rust, C#, JS/TS), локальный индекс.
  **[источник: npm deps, README, tools.ts]**
- Ограничения для Zcode: Zcode уже имеет impact/trace/context/search в CodeIndex
  (`packages/services/src/code-intelligence/contract.ts:138`, `:161`, `:205`);
  GitNexus даёт более «компиляторный» граф, но ценой второго индекса, второго MCP-сервера,
  второй модели хранения и лицензионных ограничений. Без бенчмарка на реальных репозиториях
  Zcode нельзя утверждать, что точность/латентность лучше. **[вывод]**

## 4. Сравнительная матрица

Обозначения: «н/д» — нет данных; «да/нет» — по документации. Node/TS — пригодность к встраиванию
в TypeScript/Node-продукт. Оффлайн — работает ли без обязательных внешних сервисов.

| Технология                | Категория                      | Лицензия                                              | Зрелость (2026-11-19)                                                        | Node/TS                         | Оффлайн                                                    | Требования                                    | Безопасность                                         | Стоимость интеграции/сопровождения                    | Польза Zcode                                                     | Риски                                                                |
| ------------------------- | ------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| **GitNexus**              | Локальный граф кода + MCP      | PolyForm Noncommercial 1.0.0                          | Высокая активность, но 1.6.x + 241 RC; 48.7k stars                           | Да (TypeScript)                 | Да для индекса; `analyze` может ставить расширения из сети | Node `^22.18                                  |                                                      | >=24.11`; 230.6 МБ; нативные tree-sitter/LadybugDB    | Локальный индекс, opt-in LLM; пишет файлы в репо; noncommercial  | Высокая: второй рантайм, native-зависимости, лицензия, обновления RC | Средняя: impact/trace/rename, мультиязычность; дублирует CodeIndex | Лицензия, размер, npm 11, запись в репо, нестабильный API |
| **SCIP** (Sourcegraph)    | Формат индекса кода (protobuf) | Apache-2.0                                            | 892 stars, pushed 2026-11-18; индексеры для многих языков                    | Да (есть scip-typescript и др.) | Да: индекс — файл; генерация может требовать сборки        | Индексер на язык; protobuf; build-шаг         | Индекс содержит символы/ссылки; хранить как артефакт | Средняя: импорт формата, маппинг в свою схему         | Высокая: компиляторная точность ссылок там, где есть индексер    | Build-шаг, версии индексеров, покрытие языков                        |
| **LSIF**                  | Формат индекса (JSON lines)    | MIT (lsif-node); спецификация открыта                 | 200 stars, pushed 2026-10-22; поддерживается, но Sourcegraph продвигает SCIP | Да (lsif-node)                  | Да                                                         | Индексер; JSON lines; build-шаг               | Как SCIP                                             | Средняя/высокая: legacy-формат                        | Низкая/средняя: полезен только для legacy-индексеров             | Устаревание относительно SCIP                                        |
| **Kythe**                 | Граф кода + сервер             | Apache-2.0                                            | 2 171 stars, pushed 2026-09-18; зрелый, но тяжёлый                           | Частично (есть Go/Java)         | Да, но нужен сервер/БД                                     | Kythe-сервер, индексеры, хранилище            | Полный граф; сложная эксплуатация                    | Высокая: сервер, схема, индексеры                     | Средняя: эталонный граф, но избыточен для десктопа               | Вес, сложность, сопровождение                                        |
| **Glean**                 | Факты о коде + query-сервер    | BSD (Facebook BSD)                                    | 1 445 stars, pushed 2026-11-19; used at Meta; Angle                          | Нет нативного TS-клиента        | Да, но нужен сервер/БД                                     | Glean server, indexers, Angle; Docker demo    | Серверная БД; контроль доступа                       | Высокая: сервер, индексеры, язык запросов             | Средняя/низкая для Zcode                                         | Вес, Hack/Angle, инфраструктура                                      |
| **CodeQL**                | Семантический анализ/запросы   | CLI: GitHub CodeQL Terms; queries: MIT                | 10 386 stars, pushed 2026-11-19; индустриальный стандарт                     | Нет (CLI)                       | Частично; лицензия ограничивает                            | CodeQL CLI, база, сборка                      | Очень мощный, но лицензионные ограничения            | Высокая: лицензия, сборка баз, CI                     | Низкая для продукта: не для приватного кода без платной лицензии | Юридические ограничения, вес, false positives                        |
| **Semgrep**               | Поиск паттернов/security       | Движок LGPL-2.1; правила — Semgrep Rules License v1.0 | 17 822 stars, pushed 2026-11-19                                              | Да (CLI, есть обёртки)          | Да (CE)                                                    | Python/бинарь; правила; опционально платформа | Локальный запуск; правила могут требовать доверия    | Средняя: внешний процесс, правила                     | Средняя: security-сканы, не навигация                            | LGPL, лицензия правил, шум                                           |
| **LSP**                   | Протокол IDE-функций           | Спецификация Microsoft; лицензии серверов разные      | Зрелый стандарт                                                              | Да                              | Да (локальные серверы)                                     | Сервер на язык; JSON-RPC; сессия              | Сервер — отдельный процесс, доступ к файлам          | Средняя/высокая: per-language серверы, lifecycle      | Высокая: definition/references/diagnostics                       | Не индекс; сессионность; зрелость серверов разная                    |
| **tree-sitter**           | Парсер/инкрементальный CST     | MIT                                                   | 27 506 stars, pushed 2026-11-19                                              | Да (`web-tree-sitter` 0.25.10)  | Да                                                         | WASM/нативные грамматики                      | Парсинг локальный, без сети                          | Низкая: уже используется                              | База CodeIndex                                                   | Синтаксис без типов; грамматики надо обновлять                       |
| **Salsa**                 | Инкрементальные вычисления     | Apache-2.0                                            | 3 031 stars, pushed 2026-11-18                                               | Нет (Rust)                      | Да                                                         | Rust-крейт                                    | Н/д                                                  | Высокая для переноса идей; не для прямого встраивания | Идеи для инвалидации, не готовый компонент                       | Другой язык/рантайм                                                  |
| **node-pty**              | PTY/терминал                   | MIT (Expat)                                           | 2 064 stars, pushed 2026-11-02                                               | Да                              | Да                                                         | Нативные бинарники; rebuild под Electron      | Запускает shell с правами пользователя               | Низкая: уже используется                              | Терминал/агент                                                   | Нативные сбои, права shell                                           |
| **bubblewrap / Landlock** | Песочница (Linux)              | LGPL-2.1 / ядро Linux                                 | bwrap 9 555 stars, pushed 2026-10-14; Landlock с Linux 5.13                  | bwrap — CLI; Landlock — syscall | Да                                                         | bwrap/namespaces; Landlock ABI                | Изоляция FS/сети; unprivileged                       | Средняя: политики, совместимость                      | Повышает безопасность Bash/MCP                                   | Ломает доступ к HOME/creds; не на всех ОС                            |
| **Firecracker / gVisor**  | Микро-VM/User-space kernel     | Apache-2.0                                            | Firecracker 38 111 stars, gVisor 20 054                                      | Нет нативного TS                | Да                                                         | KVM/OCI; Linux                                | Сильная изоляция                                     | Очень высокая для десктопа                            | Низкая: избыточно                                                | Вес, платформа, эксплуатация                                         |
| **MCP (спецификация)**    | Протокол инструментов          | Открытая спецификация                                 | 2025-06-18                                                                   | Да                              | stdio — да; HTTP — сеть                                    | JSON-RPC; stdio/Streamable HTTP               | Origin validation, auth для HTTP                     | Низкая: уже реализовано                               | Интеграция внешних инструментов                                  | Недоверенные серверы, prompt injection                               |

### 4.1 Ключевые выводы по матрице

1. **Формат, а не сервер.** Наибольшую пользу при низкой стоимости даёт не GitNexus, а импорт
   **SCIP** (Apache-2.0): файл-индекс с компиляторной точностью, без второго сервера.
   GitNexus и Glean/Kythe — это «сервер + БД + индексеры», что для десктопного продукта дорого. **[вывод]**
2. **LSP дополняет, а не заменяет индекс.** LSP даёт definition/references/diagnostics в сессии,
   но не постоянный ranked-контекст. Zcode сейчас не поддерживает `lspServers` в плагинах
   (`apps/zcode-cli/packages/adapters/src/plugins/index.ts:108`,
   `apps/zcode-cli/packages/contracts/src/plugins/index.ts:163`). **[источник]**
3. **tree-sitter — уже выбранная база.** Синтаксис без типов; для семантики нужен либо LSP, либо
   SCIP, либо компиляторный индексер. **[вывод]**
4. **Песочницы:** bwrap уже есть как настройка (`packages/shared/src/stage4-settings/settings.ts:71-74`),
   Landlock — разумный fallback для Linux; Firecracker/gVisor для десктопа избыточны. **[источник + вывод]**
5. **CodeQL/Semgrep:** CodeQL нельзя встраивать в коммерческий продукт для приватного кода без
   лицензии; Semgrep CE можно рассматривать как внешний плагин, но не как ядро. **[источник + вывод]**

## 5. Сверка с Zcode: что уже есть

### 5.1 Локальный CodeIndex

- Единый сервис и контракт: `packages/services/src/code-intelligence/CONTRACT.md` (единственный
  владелец локального индекса), `contract.ts:138` (`CodeIntelligenceService`), `:161` (`search`),
  `:205` (`trace`); реализация — `codeIntelligenceService.ts:397` (`search`), `:465` (`trace`).
- Инструмент модели: `apps/zcode-cli/packages/core/src/tool/handlers/code-index.ts:11-17`
  (actions `status/search/context/impact/trace`), `:46-71` (alwaysLoad, readOnly, без approval),
  `:62` (maxOutputBytes 24 000), `:91-95` (inline-бюджет вместо побайтового truncate).
  Комментарий `:66-69` фиксирует измеренный эффект: 5 412 вызовов Grep против 241 CodeIndex,
  когда инструмент был deferred — то есть resident-режим важен.
- Схема хранилища: `worker/storeSchema.ts:56` (`SCHEMA_VERSION = 4`), `:69-197`
  (`meta`, `strings`, `files`, `symbols`, `edges`, `refs`, `chunks`, `chunks_fts` FTS5,
  `chunk_vectors`, `sketch_postings`); `files.pagerank` (`:96`) и индекс по tier/pagerank (`:102`).
  **Замечание:** `CONTRACT.md` всё ещё описывает schema v2 — это doc drift, который стоит закрыть.
- Парсинг: `worker/indexEngine.ts` (пайплайн scan/parse/write, `:65` очередь записи, `:122`
  чтение schemaVersion), `ast/parserPool.ts`, `ast/languageRegistry.ts`; зависимости
  `web-tree-sitter 0.25.10` и `tree-sitter-wasms 0.1.13` в `packages/services/package.json`.
- Инкрементальность: `workspaceWatcher.ts:102-107` (один watcher на workspace, debounce 500 мс),
  `:185-186` (chokidar с пре-фильтрацией до inotify), события add/change/unlink.
- Сканирование/лимиты: `worker/workspaceScan.ts`; индекс не выходит за workspace
  (инструмент явно обещает «never reads or writes outside the current workspace»,
  `code-index.ts:54`).
- Граф и ранжирование:
  - `worker/graphRank.ts:14-15` — `DAMPING = 0.85`, `ITERATIONS = 15`; `:104-121` — центральность
    символа `log1p(in_degree * 2 + out_degree)`.
  - `ranking/searchChannels.ts:11` — `bm25(chunks_fts, 4.0, 6.0, 1.0)`, `:42` — каналы
    `fts/vector/exact/graph`, `:143` — OR-отбор + проверка покрытия термов.
  - `ranking/rrfReranker.ts:16` — `RRF_K = 60`; `:74-87` — веса exact/fts/vector/graph;
    `:209` — `diversifyByFile(maxPerFile = 2)`.
  - `ranking/tokenBudgetPacker.ts:17` — `DEFAULT_MAX_TOKENS = 4000`; `:142` —
    `MAX_RESULT_JSON_BYTES = 24_000`; `:85-131` — упаковка со signature-only при нехватке бюджета.
- Векторный канал: `ranking/localSketch.ts` (локальный 256-битный sketch, без сети);
  провайдерские эмбеддинги опциональны, `embeddings.ts:8` фиксирует «loopback-only для Ollama,
  HTTPS для внешних», `:75-84` — валидация URL; ключ хранится в credential store
  (`embeddingSettings.ts:10-14`).
- Настройки: `packages/shared/src/stage4-settings/settings.ts:52-59` — autoStart=true,
  enableVectorChannel=true, budget 4 000 (диапазон 1 000–12 000); `:156-161` — те же дефолты.
- Бенчмарк: `docs/architecture/stage4-3-code-intelligence-benchmark.md:33-45` —
  Recall@4 0.9167, Recall@12 1.0000, MRR@12 0.8889, p50 29.3 мс (цель 25 мс не достигнута),
  p95 56.3 мс; схема v3 сократила БД на 170.1 МБ (−40 %). Это внутренний замер на фикстуре,
  не сравнение с GitNexus.

### 5.2 MCP-инфраструктура

- Схемы: `packages/shared/src/mcp.ts:30-54` (`McpServerConfig`), `:398-477` —
  `CommunityMcpPresetBase` / `CommunityMcpPreset` / `McpRegistryMarketplaceEntry`;
  `:627-733` — `COMMUNITY_MCP_PRESETS`; `:735-745` — `communityMcpPresetConfig`;
  `:747` — `filterCommunityMcpPresets`.
- Установка пресета: `packages/ui/src/settings/mcp-settings-section/mcpSettingsPresets.ts:46` —
  `addServer(preset.id, communityMcpPresetConfig(preset), projectPath)`; каталог сам по себе
  ничего не запускает, но после добавления сервер считается включённым:
  `packages/services/src/mcp-sync/service/serverMapConfig.ts:8-9` — `enabled` читается как
  `!== false`, то есть отсутствие поля = включён. Это ключевой аргумент против добавления
  GitNexus «выключенным по умолчанию» без изменения семантики.
- Транспорт/процессы: `apps/zcode-cli/packages/adapters/src/mcp/stdio-transport.ts` (spawn,
  Windows Job Object, process tree), `process-tree.ts`; env — `network.ts:10-21`
  (`buildMcpStdioEnv`: sanitize + network egress env + PATH текущего Node),
  `connection-lifecycle.ts:542-544`.
- Пул и жизненный цикл: `pool.ts:61` (idle grace), `:116-155` (revalidate/reconnect),
  `:215-265` (connection key, создание/переиспользование).
- Нормализация инструментов: `descriptor.ts:10-43` (имя `mcp__server__tool`, annotations,
  timeout, official-флаг), `core/src/mcp/index.ts:52-57` (30 с, result paging 40 000/1 000 000 байт,
  до 32 сохранённых результатов), `core/src/mcp/app-tools.ts:51-55` (readOnly — без approval,
  остальные — approval, risk medium/high).
- OAuth: `adapters/src/mcp/oauth*.ts`, `official-auth.ts`; официальные MCP-креды —
  `packages/services/src/official-mcp/officialMcpCredentials.ts:13-16` (заголовки
  `X-Bigmodel-Authorization` + MaaS JWT), аудит — `officialMcpIssuanceAudit.ts`.
- Синхронизация/каталоги: `mcp-sync/service/marketplace.ts:10` — Cline marketplace URL,
  `:12` — официальный MCP Registry; `directorySync.ts:20/33`; импорт из внешних конфигов —
  `importServers.ts:14`; пер-серверный `enabled` — `serverMapConfig.ts:12-20`, `:161-198`.
- UI-каталог: `McpCommunityCatalog.tsx`, `mcpRegistryCatalogView.ts`, `McpSettingsSection.tsx`
  (детали не менялись; важно, что схема каталога уже есть и расширяется без протокола).

### 5.3 Плагины, LSP и терминал

- Плагинная модель знает компонент `lspServers`, но загрузчик его явно не поддерживает:
  `adapters/src/plugins/index.ts:108` — `UNSUPPORTED_COMPONENT_KEYS` включает `lspServers`;
  контракт — `contracts/src/plugins/index.ts:163`.
- Терминал: `packages/services/src/terminal/terminalService.ts:6` (`node-pty`),
  `:17-37` (ленивый импорт и ошибка при отсутствии), `:103-140` (spawn-helper и права).
- Песочница: `packages/shared/src/stage4-settings/settings.ts:71-74` — режимы
  `auto|bwrap|seatbelt|off`, по умолчанию `off`; комментарий фиксирует причину: не ломать
  доступ к HOME/gh/ssh. MCP stdio в просмотренных файлах получает sanitized env и сетевой egress,
  но не оборачивается в bwrap/seatbelt автоматически; это **наблюдение по коду**, полный
  lifecycle мог быть вне выборки — помечено как unknown.

### 5.4 Чего не хватает

1. **Семантической точности компилятора.** tree-sitter даёт синтаксис; нет типов, перегрузок,
   generics, кросс-языковых ссылок. SCIP/LSP — кандидаты.
2. **Кросс-репозиторного/внешнего графа.** CodeIndex ограничен workspace; GitNexus тоже
   индексирует проект, но умеет shared stores; для Zcode это не цель по умолчанию.
3. **LSP-возможностей** (definition/references/diagnostics/hover) — компонент объявлен, но не
   реализован.
4. **Песочницы для MCP stdio.** Есть bwrap/seatbelt для Bash, но не для произвольных MCP-серверов.
5. **Лицензионного поля в каталоге.** `CommunityMcpPreset` не выражает «noncommercial»,
   «требует предварительной индексации», «требует Node >= X»; `usageLabel` — закрытый union
   из трёх значений (`mcp.ts:398-477`). Без расширения схемы добавлять GitNexus в каталог нельзя
   без потери предупреждений.

## 6. Приоритизированные рекомендации

### P0 — сделать сейчас

1. **Не интегрировать GitNexus** (ни в ядро, ни в статический каталог) до юридической проверки
   PolyForm Noncommercial и появления полей лицензии/предусловий в каталоге.
2. **Сохранить CodeIndex единственным владельцем** локального индекса. Любой внешний индекс —
   только как опциональный импорт, не как второй автостартующий индекс.
3. **Закрыть doc drift:** обновить `packages/services/src/code-intelligence/CONTRACT.md`
   (schema v2 → фактическая v4, актуальные лимиты и языки), добавить проверку соответствия
   констант `storeSchema.ts` и документа.
4. **Явно документировать границы CodeIndex** (workspace-only, tree-sitter, без типов) в
   описании инструмента и в пользовательской документации; это снижает ложные ожидания
   и преждевременные внешние интеграции.

### P1 — следующий шаг

1. **SCIP-импорт (Apache-2.0).** Добавить опциональный импорт `.scip` в `symbols/refs/edges`
   как read-only источник для языков, где есть индексер. Плюс: компиляторная точность без
   второго сервера; минус: build-шаг и маппинг версий. Не автостарт, не обязательный канал.
2. **Поддержка `lspServers` в плагинах** вместо игнорирования (`adapters/src/plugins/index.ts:108`).
   Использовать LSP для definition/references/diagnostics по запросу, CodeIndex — для ранжирования
   и контекста. Нужен lifecycle: lazy start, idle stop, per-workspace isolation.
3. **Песочница для MCP stdio.** Переиспользовать `sandboxSettings` (bwrap/seatbelt) и/или Landlock:
   профиль FS/network, лимиты CPU/памяти, обязательный таймаут и process-tree kill
   (последнее уже есть). По умолчанию — как сейчас (`off`), но с предупреждением в UI.
4. **Расширить схему каталога MCP** полями `license`, `requiresUserInstall`, `prerequisites`,
   `defaultEnabled: false`. Только после этого возможна запись GitNexus (раздел 7).

### P2 — по мере спроса

1. Расширение грамматик tree-sitter и версии `web-tree-sitter`; регрессионный бенчмарк на
   реальных репозиториях, а не только фикстурах.
2. Внешний Semgrep CE (LGPL-2.1, правила — Semgrep Rules License) как плагин для security-сканов;
   не встраивать в ядро.
3. Идеи Salsa для инвалидации кэша (query-based memoization) — если инкрементальный индекс станет
   узким местом; прямой перенос Rust-крейта в TS нецелесообразен.
4. Firecracker/gVisor — не рассматривать для десктопа: высокая стоимость, Linux/KVM, избыточная
   изоляция для локального агента.

## 7. Решение по GitNexus

**Решение: не интегрировать сейчас.** Это осознанный отказ, а не «недостаточно данных».

Обоснование:

1. **Лицензия.** PolyForm Noncommercial 1.0.0; коммерческое использование требует договора с
   правообладателем. Zcode — коммерческий продукт; каталог не умеет показывать лицензию и
   ограничения, а `usageLabel` — закрытый union. Это создаёт юридический и UX-риск.
2. **Требование «выключено по умолчанию» не выражается схемой.** В Zcode сервер включён, если
   `enabled !== false` (`serverMapConfig.ts:8-9`); `communityMcpPresetConfig` (`mcp.ts:735-745`)
   не выставляет `enabled`. Чтобы запись была выключена, нужно менять общую семантику каталога
   или добавлять специальное поле — это уже не «дешёвая запись».
3. **Предусловия не помещаются в карточку.** Node `^22.18 || >=24.11`, первый `npx` на 230 МБ,
   npm 11 workaround, обязательный `gitnexus analyze` (пишет `AGENTS.md`, `.claude/skills`,
   `.gitnexus/`), возможная сетевая установка расширений LadybugDB. Пользователь, добавивший
   пресет, получит неработающий или долго стартующий сервер без объяснения.
4. **Дублирование.** CodeIndex уже покрывает search/context/impact/trace с измеренным качеством;
   GitNexus не даёт доказанного выигрыша на корпусе Zcode.
5. **Сопровождение.** 241 RC-тег, нативные зависимости, быстрый темп изменений — высокий риск
   для пресета, который пользователь ожидает «просто работающим».

Если продукт пересмотрит решение, минимальная безопасная форма:

```ts
// packages/shared/src/mcp.ts — COMMUNITY_MCP_PRESETS
{
  id: "gitnexus",
  kind: "stdio",
  name: "GitNexus",
  description:
    "Local code graph + MCP. Requires Node ^22.18.0 || >=24.11.0 and a prior " +
    "`npx gitnexus analyze`; licensed PolyForm Noncommercial 1.0.0.",
  packageName: "gitnexus",
  version: "1.6.12",
  command: "npx",
  args: ["-y", "gitnexus@1.6.12", "mcp"],
  authRequirement: "none",
  sourceUrl: "https://github.com/abhigyanpatwari/GitNexus",
}
```

Дополнительно (до появления полей каталога): при установке писать `enabled: false` в конфиг
сервера, не запускать `connect` автоматически, показывать лицензию и предусловия, не вызывать
`analyze` из Zcode. Без этих изменений запись добавлять нельзя.

## 8. Риски и неизвестные

- **Лицензионная квалификация.** Является ли публикация ссылки на noncommercial-инструмент в
  коммерческом каталоге «коммерческим использованием» — вопрос к юристам; в отчёте это риск,
  а не юридическое заключение.
- **Телеметрия GitNexus.** `@scarf/scarf` объявлен, но в `gitnexus/src`/`scripts` не найден.
  Поведение опубликованного бандла и транзитивных зависимостей не аудировано — `unknown`.
- **Сетевые вызовы.** `analyze` может ставить расширения БД; `mcp` — нет. Проверено по
  документации, не по сетевым дампам.
- **Качество GitNexus на реальных репозиториях Zcode** не измерялось; сравнение с CodeIndex
  по точности/латентности отсутствует.
- **Безопасность MCP stdio в Zcode**: в просмотренных файлах нет автоматической bwrap/seatbelt
  обёртки; полный lifecycle не исчерпан, поэтому это наблюдение, а не доказанное отсутствие.
- **Актуальность CONTRACT.md**: документ отстаёт от схемы v4; любые выводы по нему нужно
  перепроверять по `storeSchema.ts`.
- **Semgrep/CodeQL**: лицензии правил и CLI проверены по LICENSE-файлам; использование в
  конкретном продукте требует отдельной проверки условий.

## 9. Выполненные проверки

- Веб-источники: получены 2026-11-19 (curl/WebFetch), см. раздел 10.
- Код Zcode: чтение исходников с `file:line`; точечные `rg`/`sed` по перечисленным файлам.
- `git status --short` — см. финальный отчёт ветки; отчёт добавлен как новый файл, код не менялся.
- Тесты/typecheck: **не запускались**, потому что в этой ветке нет изменений кода и не добавлялась
  запись каталога (по решению раздела 7). Полный `pnpm test`/сборка не запускались.
- `node scripts/check-workspace-freshness.mjs` — результат фиксируется в отчёте ветки, если запущен;
  иначе считается непроверенным.

## 10. Источники (дата обращения 2026-11-19)

GitNexus:

- https://github.com/abhigyanpatwari/GitNexus
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/README.md
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/LICENSE
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/package.json
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/gitnexus/package.json
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/gitnexus/README.md
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/docs/mcp-reference.md
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/docs/cli-reference.md
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/SECURITY.md
- https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/ARCHITECTURE.md
- https://registry.npmjs.org/gitnexus/latest
- https://api.github.com/repos/abhigyanpatwari/GitNexus
- https://api.github.com/repos/abhigyanpatwari/GitNexus/license
- https://api.github.com/repos/abhigyanpatwari/GitNexus/tags?per_page=5
- https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/src/mcp/tools.ts

Графы кода и анализ:

- https://github.com/sourcegraph/scip (канонический редирект: `scip-code/scip`)
- https://sourcegraph.com/blog/announcing-scip
- https://microsoft.github.io/language-server-protocol/specifications/lsif/0.4.0/specification/
- https://github.com/microsoft/lsif-node
- https://kythe.io/docs/kythe-overview.html
- https://github.com/kythe/kythe
- https://glean.software/
- https://github.com/facebookincubator/Glean
- https://raw.githubusercontent.com/facebookincubator/Glean/main/LICENSE
- https://github.com/github/codeql
- https://raw.githubusercontent.com/github/codeql-cli-binaries/main/LICENSE.md
- https://github.com/semgrep/semgrep
- https://raw.githubusercontent.com/semgrep/semgrep/develop/LICENSE
- https://raw.githubusercontent.com/semgrep/semgrep-rules/develop/LICENSE
- https://docs.semgrep.dev/

LSP, tree-sitter, инкрементальность, песочницы, MCP:

- https://microsoft.github.io/language-server-protocol/overviews/lsp/overview/
- https://tree-sitter.github.io/tree-sitter/
- https://github.com/tree-sitter/tree-sitter
- https://github.com/salsa-rs/salsa
- https://github.com/microsoft/node-pty
- https://github.com/containers/bubblewrap
- https://raw.githubusercontent.com/containers/bubblewrap/main/COPYING
- https://docs.kernel.org/userspace-api/landlock.html
- https://firecracker-microvm.github.io/
- https://github.com/firecracker-microvm/firecracker
- https://gvisor.dev/docs/
- https://github.com/google/gvisor
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

Метаданные сравнения (GitHub API, 2026-11-19): `scip-code/scip` (Apache-2.0, 892, pushed 2026-11-18),
`microsoft/lsif-node` (MIT, 200, 2026-10-22), `kythe/kythe` (Apache-2.0, 2 171, 2026-09-18),
`facebookincubator/Glean` (NOASSERTION/BSD, 1 445, 2026-11-19), `github/codeql` (MIT, 10 386,
2026-11-19), `semgrep/semgrep` (LGPL-2.1, 17 822, 2026-11-19), `tree-sitter/tree-sitter`
(MIT, 27 506, 2026-11-19), `microsoft/node-pty` (NOASSERTION/MIT-текст, 2 064, 2026-11-02),
`containers/bubblewrap` (NOASSERTION/LGPL-2.1, 9 555, 2026-10-14), `firecracker-microvm/firecracker`
(Apache-2.0, 38 111, 2026-11-18), `google/gvisor` (Apache-2.0, 20 054, 2026-11-19),
`salsa-rs/salsa` (Apache-2.0, 3 031, 2026-11-18).
