# Этап 2: Глубокое сравнительное исследование `kilocode-legacy-main` и открытых SOTA агентных систем — матрица архитектурного отбора

**Дата исследования:** `2026-11-16`  
**Целевой монорепозиторий:** `<home>/Desktop/git/Zcode` (лицензия [Apache-2.0](../../LICENSE), среда `Node.js 24.14.0`, `pnpm 10.33.2`, `Electron 41.0.3`)  
**Локальный референсный репозиторий:** `<home>/Desktop/git/kilocode-legacy-main` (`v5.16.2`, лицензия `Apache-2.0`, аккумулирующий кодовую базу Kilo Code, Roo Code, Cline и встроенное ядро Continue Dev)  
**Базовый контекст:** [Отчёт Этапа 1 (криминалистический аудит и базовые метрики)](stage1-forensic-audit-and-baseline.md)  
**Статус исходного кода Zcode:** Не модифицирован (режим read-only для всех исходных пакетов).

---

## 0. Методология и архитектурные инварианты отбора

Настоящий документ фиксирует результаты глубокого исходно-кодового разбора локального референса `kilocode-legacy-main` и сравнительного анализа ведущих открытых агентных систем (**OpenAI Codex CLI**, **Aider**, **Continue**, **Cline / Roo Code**, **OpenHands**, **Zed**) для устранения корневых дефектов `F-01`–`F-07`, доказанных на [Этапе 1](stage1-forensic-audit-and-baseline.md).

Любое отбираемое решение проходит через 5 жёстких фильтров:
1. **Юридическая чистота (`Apache-2.0` compatibility):** допускаются исключительно библиотеки, алгоритмы и `.wasm`-грамматики под пермиссивными лицензиями (`Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`) с полным соблюдением [LICENSE](../../LICENSE) и [NOTICE.md](../../NOTICE.md). Пакеты и грамматики под `GPL`/`LGPL`/`AGPL`/`MPL` в линкуемом коде и бандлах отклоняются.
2. **Соблюдение границ слоёв Zcode ([architecture-policy.yaml](../../architecture-policy.yaml)):** отсутствие циклических зависимостей, сохранение `AgentRuntime` (`apps/zcode-cli`) единственным владельцем состояния хода и диалога, разделение потоков `desktop-continuous` (Desktop IPC) и `web-remote-replayable` (Mobile/Web Relay с байтовым бюджетом снимков), сквозная изоляция по ключу `workspaceIdentity?.trim() || workspacePath`.
3. **Совместимость с упаковкой Electron 41 + V8 Bytecode + Node 24 SEA:** отказ от тяжёлых C++/Rust N-API аддонов там, где доступны встроенный в Node 24 `node:sqlite` (`FTS5`), предсобранные бинарники Zcode (`bfs`, `ripgrep`, `ugrep`), `web-tree-sitter` (WASM) или уже встроенный zero-compile FFI `koffi`.
4. **Нативная адаптация вместо обёрток-времянок:** мы не переносим чужие классы «как есть» с VS Code API-заглушками, а синтезируем лучшие алгоритмы напрямую в контракты `@zcode/contracts`, `@zcode/core`, `@zcode/adapters`, `@zcode/services` и `@zcode/ui`.
5. **100% работоспособность из коробки на Linux и macOS:** все решения для песочницы и Computer Use верифицированы против реального системного окружения рабочей машины разработчика (`Linux 6.14`, `Linux Mint 22.3 / Ubuntu 24.04 Noble`).

---

## 1. Глубокий инженерный разбор исходного кода `<home>/Desktop/git/kilocode-legacy-main`

### 1.1. Diff-движок, мультифайловое редактирование, чекпоинты и Worktree-изоляция

В `kilocode-legacy-main` сосуществуют три поколения инструментов редактирования файлов и два механизма версионной изоляции:

#### А. Стратегия `SEARCH/REPLACE` с нечётким поиском и выравниванием отступов
- **Референсные файлы:**
  - `src/core/diff/strategies/multi-search-replace.ts` (`MultiSearchReplaceDiffStrategy`, строки `13–613`)
  - `src/core/diff/strategies/multi-file-search-replace.ts` (`MultiFileSearchReplaceDiffStrategy`, строки `10–714`)
  - `src/core/tools/MultiApplyDiffTool.ts`
- **Ключевые алгоритмические находки:**
  1. **Конечный автомат превалидации маркеров (`validateMarkerSequencing`, строки `193–335`):** проверяет переходы `START → AFTER_SEARCH → AFTER_SEPARATOR → START` до запуска регулярных выражений, распознаёт баги генерации маркеров моделями (`<<<<<<< SEARCH>`, `<<<<<<<< SEARCH` из 8 символов без экспоненциального backtracking), запрещает `:start_line:` внутри секции `REPLACE` и возвращает модели самодостаточную инструкцию по экранированию конфликт-маркеров Git (`\<<<<<<<`).
  2. **Агрессивная очистка артефактов чтения (`stripLineNumbers`, строки `417–428`, `504–525`):** если модель скопировала префиксы номеров строк `123 | code`, стратегия сначала снимает их штатно, а при промахе выполняет повторный fallback-проход с агрессивным снятием нумерации.
  3. **Middle-Out Fuzzy Search на базе Левенштейна (`fuzzySearch` + `getSimilarity`, строки `13–75`):** сначала проверяет точное место `startLine + delta` (где `delta` отслеживает кумулятивный сдвиг строк от предыдущих ханков в том же файле), а при расхождении расширяет поиск веером от середины окна `[startLine - 40, endLine + 40]` (`BUFFER_LINES = 40`), вычисляя `1 - distance(normalizedOrig, normalizedSearch) / maxLength` через пакет `fastest-levenshtein` с предварительной нормализацией smart-кавычек (`normalizeString`).
  4. **Относительный пересчёт табуляции и отступов (`indentedReplaceLines`, строки `557–592`):** критически важный механизм! Даже когда модель ошиблась на 2–4 пробела базового отступа всего блока `SEARCH`, алгоритм вычисляет `matchedIndent` первой строки найденного участка в файле и `searchBaseIndent` первой строки `SEARCH`, после чего для каждой строки `REPLACE` сохраняет её *относительный* сдвиг `relativeLevel = currentIndent.length - searchBaseIndent.length` относительно реального `matchedIndent` файла.
  5. **Диагностическое окно при промахе (строки `527–549`):** вместо слепого отказа возвращает процент схожести лучшего кандидата, сам блок `Best Match Found` с номерами строк и срез оригинального файла `±40` строк вокруг `startLine`, что позволяет модели исправить вызов на следующем шаге без полного `Read`.

#### Б. Каскадный литерально-токенный `EditFileTool`
- **Референсные файлы:** `src/core/tools/EditFileTool.ts` (строки `34–372`), `src/core/tools/kilocode/editFileTool.ts`.
- **Ключевые алгоритмические находки:**
  1. Нормализация `CRLF → LF` перед поиском и гарантированное восстановление исходного `originalEol` (`restoreLineEnding`).
  2. Защита от бага `String.prototype.replaceAll` со спецсимволами `$&`, `$'`, `` $` ``, `$1` в JS/TS/Bash-коде через удвоение `newString.replaceAll("$", "$$$$")` (`safeLiteralReplace`, строки `55–69`).
  3. Трёхступенчатый детерминированный каскад со строгой проверкой `occurrences === expectedReplacements`:
     - **Pass 1:** точное подстрочное вхождение (`countOccurrences`);
     - **Pass 2:** `buildWhitespaceTolerantRegex` (горизонтальные пробелы маппятся в `[\t ]+`, а пробельные группы с `\n` — в `\s+`, что переживает лишние/пропущенные пустые строки и переносы длинных выражений!);
     - **Pass 3:** `buildTokenRegex` (разбиение на непробельные токены, соединённые `\s+`).
  4. Пер-файловый счётчик ошибок `consecutiveMistakeCountForEditFile` с подробным `<error_details>` (точное число найденных совпадений на каждом уровне строгости).

#### В. Порт `apply_patch` спецификации OpenAI Codex
- **Референсные файлы:** `src/core/tools/ApplyPatchTool.ts`, `src/core/tools/apply-patch/parser.ts`, `src/core/tools/apply-patch/seek-sequence.ts`, `src/core/tools/apply-patch/apply.ts`.
- **Ключевые алгоритмические находки:**
  - Безнамерная ханковая грамматика `*** Begin Patch` → `*** Add File:` / `*** Delete File:` / `*** Update File:` (+ `*** Move to:`) → `@@ [changeContext]` → строки ` `, `-`, `+` → `*** End Patch` (с поддержкой heredoc `<<EOF`).
  - 4-проходный `seekSequence` (`exactMatch` → `trimEndMatch` → `trimMatch` → `normalizeUnicode` для типографских тире `\u2010–\u2212`, кавычек `\u2018–\u201F` и неразрывных пробелов `\u00A0–\u3000`), приоритет поиска с конца файла при `*** End of File` и модификация копии массива строк строго в обратном порядке индексов (`applyReplacements`), исключающая сдвиг смещений.

#### Г. Критическая перекрёстная сверка с текущим кодом Zcode (почему `Edit` в Zcode падал 11 раз)
Сверка `kilocode-legacy-main` с реальными файлами Zcode [edit.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L214), [edit-matchers.ts](../../apps/zcode-cli/packages/core/src/tool/edit-matchers.ts#L41), [apply-patch.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts#L60) и [patch-apply.ts](../../apps/zcode-cli/packages/core/src/tool/patch-apply.ts#L11) вскрыла **четыре тонких инженерных изъяна**, не очевидных без построчного анализа:
1. **Отсутствие ре-индентации `new_string` в Zcode `Edit`:** в [edit-matchers.ts](../../apps/zcode-cli/packages/core/src/tool/edit-matchers.ts#L189) уже есть стратегия `indentation_flexible` (`removeCommonIndent`), но когда она находит блок с отступом 4 пробела по запросу `old_string` с отступом 2 пробела, [edit.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L242) подставляет `new_string` **как есть (с 2 пробелами!)** без алгоритма относительного сдвига отступов из `multi-search-replace.ts:570–592`. Для Python (`FastAPI` в сессии Этапа 1) это мгновенно порождает `IndentationError`!
2. **Нетерпимость `line_trimmed` / `indentation_flexible` / `block_anchor` в Zcode к сдвигу пустых строк:** в [edit-matchers.ts](../../apps/zcode-cli/packages/core/src/tool/edit-matchers.ts#L204) `collectBlockAnchorCandidates` проверяет окно строго фиксированной длины `searchLines.length`. Если модель пропустила или добавила хотя бы одну пустую строку внутри 25-строчной функции, `block[block.length - 1]` съезжает на 1 строку и все 8 стратегий возвращают `not_found`. В `EditFileTool.ts` (`kilocode-legacy-main`) `whitespaceTolerantRegex` (`\s+`) и динамический поиск нижней границы якоря легко находят такой блок.
3. **Слепой ответ при `OLD_STRING_NOT_FOUND`:** [edit.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L220) возвращает только `String to replace not found in file` без ближайшего совпадения (`Best Match Found` + номера строк), заставляя агента вызывать `Read` на весь файл.
4. **Отсутствие атомарного rollback мультифайлового патча и в `kilocode-legacy-main`, и в Zcode:** в `ApplyPatchTool.ts:83–108` и в [apply-patch.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts#L65) запись идёт в цикле по файлам; хотя Zcode предварительно валидирует секции (`verifySection`), сбой записи на 3-м файле (например, конфликт `expectedRevision` от параллельного субагента) оставляет файлы 1 и 2 перезаписанными на диске без отката!

#### Д. Теневые чекпоинты и Git Worktree-изоляция агентов
- **`src/services/checkpoints/ShadowCheckpointService.ts` (строки `45–430`):** создаёт изолированный теневой git-репозиторий с `core.worktree = workspaceDir`, принудительно вычищая из окружения `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, проверяет вложенные `.git/HEAD` через `ripgrep` и блокирует запуск в `$HOME`/`Desktop`/`Downloads`. *Недостаток для Zcode:* `git add .` на теневом worktree в монорепозитории из 11 725 файлов создаёт заметную IO-нагрузку и блокирует `.git/index.lock` при параллельных субагентах.
- **`src/core/kilocode/agent-manager/WorktreeManager.ts` (строки `63–497`):** эталонная изоляция параллельных сессий через `git worktree add -b <branch> <projectRoot>/.kilocode/worktrees/<branch>` с автоматической пропиской `.kilocode/worktrees/` в `.git/info/exclude` (не пачкая пользовательский `.gitignore`), привязкой `session-id` и получением диффа `git diff parentBranch...HEAD`.

---

### 1.2. Индексация кода (`code-index`) и парсинг через `web-tree-sitter`

- **Референсные файлы:**
  - `src/services/tree-sitter/languageParser.ts` (строки `40–231`), `src/services/tree-sitter/index.ts`, `src/services/tree-sitter/markdownParser.ts`, `src/services/tree-sitter/queries/*.ts` (28 языковых схем).
  - `src/services/code-index/processors/parser.ts` (`CodeParser`, строки `17–551`).
  - `src/services/code-index/processors/scanner.ts` (`DirectoryScanner`, строки `34–618`).
  - `src/services/code-index/processors/file-watcher.ts` (`FileWatcher`, строки `34–516`).
  - `src/services/code-index/cache-manager.ts`, `src/services/code-index/constants/index.ts`, `src/services/glob/constants.ts`, `src/services/code-index/vector-store/lancedb-vector-store.ts`.
- **Ключевые архитектурные находки:**
  1. **WASM-архитектура Tree-sitter без нативных пересборок:** `web-tree-sitter@^0.25.6` инициализируется один раз (`Parser.init()`), а `.wasm`-грамматики (`python`, `rust`, `go`, `cpp`, `c`, `c_sharp`, `java`, `kotlin`, `ruby`, `php`, `typescript`, `tsx`, `javascript`, `solidity`, `zig`, `elixir`, `lua`, `toml`, `html`, `css`, `vue` и др.) подгружаются лениво по мере встречи расширений файлов с дедупликацией параллельных промисов в `pendingLoads: Map<string, Promise<LanguageParser>>` (`parser.ts:110–144`).
  2. **Структурно-семантический AST-чанкинг с ребалансировкой остатка (`parser.ts:173–378`):**
     - Выполняет `language.query.captures(tree.rootNode)` по теговым S-expression запросам (`@definition.class`, `@definition.function`, `@definition.method` и т.д.).
     - Если размер узла попадает в `[MIN_BLOCK_CHARS = 50, MAX_BLOCK_CHARS * 1.15 = 1150]` символов, узел целиком становится семантическим чанком с сохранением `identifier` (`childForFieldName("name")`), `type`, `start_line`, `end_line` и детерминированного `segmentHash` (`SHA-256`).
     - Если узел превышает `1150` символов и имеет дочерние AST-узлы — декомпозируется в ширину (BFS по `children`); если это листовой узел или язык без грамматики — применяется `_chunkTextByLines` с **алгоритмом ребалансировки хвоста** (`MIN_CHUNK_REMAINDER_CHARS = 200`, строки `329–355`), предотвращающим появление бесполезных обрубков по 2–3 строки в конце функции, а также сегментацией минифицированных сверхдлинных строк.
     - Для Markdown (`markdownParser.ts`) выделяются иерархические секции по заголовкам `#`–`######`.
  3. **Инкрементальное кэширование и конкурентный пайплайн (`scanner.ts`, `file-watcher.ts`, `cache-manager.ts`):**
     - Кэш `SHA-256` хэшей содержимого файлов с отложенной атомарной записью (`safeWriteJson`, debounce `1500 мс`), пропуск файлов `> 1 МБ` (`MAX_FILE_SIZE_BYTES`), фильтрация `DIRS_TO_IGNORE` (`node_modules`, `__pycache__`, `venv`, `target`, `dist`, `.git`, `.*`) + `.gitignore` + `.kilocodeignore`.
     - Ограничение параллелизма `pLimit(10)` на парсинг, `Mutex` (`async-mutex`) на формирование батчей по `60` чанков с backpressure `MAX_PENDING_BATCHES = 20` и кооперативным флагом отмены `_cancelled`.
     - В `FileWatcher` события `create`/`change`/`delete` коалесцируются в `Map<filePath, event>` за окно `500 мс` и исполняются строго в 3 фазы: пакетное удаление старых чанков изменённых/удалённых файлов → параллельный ре-парсинг только затронутых файлов → пакетный upsert с экспоненциальным retry.
  4. **Выявленные ограничения индекса `kilocode-legacy-main`:**
     - Полная зависимость поиска от внешнего Qdrant или динамически скачиваемого LanceDB: **если у пользователя не настроен провайдер эмбеддингов, кодовый поиск полностью не работает** (нет автономного `FTS5`/`BM25` индекса!).
     - Tree-sitter запросы извлекают только определения (`@definition.*`), но **не строят граф символов/импортов/вызовов (`edges`)** и не ранжируют центральность файлов (PageRank). В Zcode уже есть реляционный граф в `node:sqlite`, поэтому синтез Tree-sitter чанкера `kilocode-legacy-main` с `FTS5 BM25` и графом символов в `node:sqlite` даст кратно более мощную систему!

---

### 1.3. Prompt Enhancer (`MessageEnhancer`)

- **Референсные файлы:** `src/core/webview/messageEnhancer.ts` (строки `28–143`), `src/shared/support-prompt.ts` (строки `51–55`), `src/core/webview/webviewMessageHandler.ts` (строки `2143–2185`), `webview-ui/src/components/chat/ChatTextArea.tsx` (строки `248–271`, `453–462`, `1699–1719`).
- **Как устроено:**
  - Позволяет назначить выделенный быстрый/дешёвый профиль модели (`enhancementApiConfigId`) с fallback на текущую модель чата.
  - При включённом флаге `includeTaskHistoryInEnhance` извлекает последние 10 текстовых сообщений диалога (`User`/`Assistant`, с обрезкой каждого до 500 символов).
  - В UI кнопка с иконкой `WandSparkles` переходит в `animate-spin`, а при получении `enhancedPrompt` заменяет текст через `textarea.select(); document.execCommand("insertText", false, message.text)`, сохраняя браузерный стек `Ctrl+Z` (`Undo`).
- **Критические пробелы референса (устраняемые при переносе в Zcode):**
  - Шаблон `supportPromptConfigs.ENHANCE` состоит из одной общей фразы без инжекции контекста рабочей директории, технологического стека репозитория, упомянутых `@file` или релевантных символов из `CodeIndex`;
  - Отсутствует `AbortController` (повторный клик во время вращения спиннера не отменяет запрос);
  - В Lexical (`LexicalChatInput.tsx`) нельзя полагаться на `textarea.select()`, но можно штатно применить контролируемый `editor.update()` с сохранением снимка исходного черновика для мгновенного возврата (`Undo Enhance` кнопкой или `Ctrl+Z`).

---

### 1.4. Предиктивное автодополнение в чате и коде (`ChatTextAreaAutocomplete` / `ghost`)

- **Референсные файлы:**
  - `src/services/autocomplete/chat-autocomplete/ChatTextAreaAutocomplete.ts` (строки `9–188`), `handleChatCompletionRequest.ts`.
  - `src/services/autocomplete/context/VisibleCodeTracker.ts` (строки `22–154`).
  - `src/services/autocomplete/classic-auto-complete/AutocompleteInlineCompletionProvider.ts` (строки `37–256`, `413–726`).
  - `src/services/autocomplete/continuedev/core/autocomplete/postprocessing/removePrefixOverlap.ts`.
  - `webview-ui/src/components/chat/hooks/useChatAutocompleteText.ts` (строки `26–267`).
- **Ключевые алгоритмические находки:**
  1. **Трёхрежимный кольцевой кэш префиксов (`findMatchingSuggestion`, `MAX_SUGGESTIONS_HISTORY = 20`):**
     - `exact`: мгновенный возврат при совпадении `prefix` и `suffix`;
     - `partial_typing`: когда пользователь продолжает печатать символы, совпадающие с началом уже полученного `suggestion`, остаток подсказки вычисляется локально за `0 мс` (`suggestion.substring(typedContent.length)`) без сетевых запросов;
     - `backward_deletion`: при нажатии `Backspace` подсказка бесшовно достраивается (`deletedContent + suggestion`).
  2. **Переиспользование летящих запросов (`findCoveringPendingRequest`, строки `579–593`) и адаптивный дебаунс (`recordLatency`, строки `413–428`):** если в полёте уже есть запрос для более короткого префикса с тем же суффиксом, новый таймер ждёт его промис; задержка дебаунса адаптируется по среднему из последних 10 ответов в коридоре `[150 мс, 1000 мс]` (старт `300 мс`).
  3. **Решение проблемы BPE-токенизации на границе слова (`removePrefixOverlap`):** системный промпт инструктирует модель возвращать *полное* текущее слово, если пользователь остановился посреди слова (`"исправь баг в инд"` → `"индексации файлов"`), после чего `removePrefixOverlap` аккуратно отрезает `"инд"`, оставляя чистый суффикс `"ексации файлов"`.
  4. **Клавиатурная эргономика (`useChatAutocompleteText.ts:107–163`):**
     - `Tab` (без `Shift`, только когда каретка в самом конце ввода, нет выделения и закрыты меню `/` и `@`) — принимает всю подсказку;
     - `ArrowRight` (без модификаторов в конце строки) — принимает **ровно одно следующее слово** с пробелом (`extractNextWord`: `/^(\s*\S+\s*)/`), оставляя хвост ghost-текста активным;
     - `Escape` — скрывает ghost-текст, не очищая набранный пользователем черновик;
     - Постпроцессинг отсекает многострочные ответы по первому `\n` и отфильтровывает строки, начинающиеся с комментариев кода (`//`, `/*`, `#`).
  5. **Критический недостаток референса:** на бэкенде `handleChatCompletionRequest.ts` не отменяет предыдущий HTTP-стрим через `AbortController` при быстром наборе текста, а в UI использует хрупкое зеркалирование `<textarea>` поверх прозрачного `<div>`, тогда как в Zcode уже используется **Lexical 0.42**, позволяющий рендерить inline ghost-text эталонной легковесной `GhostTextNode` прямо в DOM-потоке абзаца без рассинхронизации скролла и шрифтов!

---

### 1.5. Системные промпты, компакция контекста и OpenRouter Prompt Caching

- **Референсные файлы:** `src/api/providers/openrouter.ts` (строки `146–161`, `325–428`), `src/api/transform/caching/kilocode.ts`, `src/api/transform/caching/gemini.ts`, `src/services/autocomplete/continuedev/core/llm/openai-adapters/apis/OpenRouterCaching.ts`, `packages/types/src/providers/openrouter.ts`, `src/api/providers/kilocode/verifyFinishReason.ts`, `src/core/condense/index.ts`.
- **Ключевые находки:**
  1. **Расстановка точек кэширования (`addAnthropicCacheBreakpoints` в `caching/kilocode.ts`):** конвертирует строковый `content` в массив блоков `[{ type: "text", text, cache_control: { type: "ephemeral" } }]` ровно в **3 точках** (в пределах лимита 4 breakpoints Anthropic/OpenRouter): (1) системный промпт `role: "system"`, (2) последнее сообщение `user`/`tool`, (3) предпоследнее сообщение `user`/`tool` перед последним ответом `assistant`. Это гарантирует попадание всего префикса истории на каждом следующем шаге агентного цикла!
  2. **Вскрыта точная причина `cacheReadTokens = 0` на `qwen/qwen3.6-plus` в Zcode:**
     - На OpenRouter семейства **Anthropic (`anthropic/*`)**, **Google Gemini (`google/gemini-*`)** и **Alibaba Qwen (`qwen/*`, провайдер Alibaba/DashScope)** требуют **явной разметки `cache_control: { type: "ephemeral" }`** в мультимодальных текстовых частях сообщений OpenAI-совместимого запроса (причём даже в `kilocode-legacy-main` массив `OPEN_ROUTER_PROMPT_CACHING_MODELS` забыл включить `qwen/*`!).
     - В Zcode пакет `@ai-sdk/openai-compatible` ([патч](../../patches/@ai-sdk__openai-compatible@2.0.60.patch)) отправляет `content` обычной строкой без `cache_control` и не передаёт провайдерную привязку маршрутизации OpenRouter (`provider: { ... }`), из-за чего запросы балансируются между разными апстримами без кэша.
  3. **Сохранение инвариантов протокола при сжатии (`getKeepMessagesWithToolBlocks`, `condense/index.ts:103–158`):** при сворачивании истории находит все `tool_result` в оставляемом хвосте сообщений и переносит парные им `tool_use` **вместе с блоками `reasoning` / `thinking`** из сжимаемой области, предотвращая ошибку `400 Missing reasoning_content / orphan tool_result` у DeepSeek R1, Z.ai GLM и Claude Extended Thinking.
  4. **Явный перехват обрыва по токенам (`verifyFinishReason.ts:16–22`):** проверяет `choice?.finish_reason === "length"` до обработки ответа, не маскируя усечение под синтаксическую ошибку JSON.

---

### 1.6. Терминал, управление процессами и Browser Use

- **Референсные файлы:** `src/core/tools/ExecuteCommandTool.ts`, `src/integrations/terminal/Terminal.ts`, `src/core/kilocode/agent-manager/RuntimeProcessHandler.ts`, `src/services/browser/BrowserSession.ts` (строки `242–320`).
- **Ключевые находки:**
  - В `Terminal.ts:154–195` задаются безопасные переменные неинтерактивного вывода (`PAGER=cat`, `VTE_VERSION=0`, `PROMPT_EOL_MARK=""`), предотвращающие зависание агента на `git diff` / `systemctl` пейджерах.
  - В `BrowserSession.ts:249–283` вокруг каждого браузерного действия автоматически навешиваются слушатели `page.on("console")` и `page.on("pageerror")` с ожиданием стабилизации логов (`500 мс` тишины, потолок `3 000 мс`) и сжатием скриншота в `webp` (`quality: 75`), что в 4–6 раз легче PNG по токенам и байтам!

---

## 2. Сравнительный анализ зрелых OSS-систем и матрицы выбора по 6 доменам

Ниже приведено систематическое сравнение архитектурных подходов **Kilo Code (`kilocode-legacy-main`)**, **OpenAI Codex CLI** (`Apache-2.0`), **Aider** (`Apache-2.0`), **Continue** (`Apache-2.0`), **Cline / Roo Code** (`Apache-2.0`), **OpenHands** (`MIT`) и **Zed** (`GPL-3.0` для клиента / `Apache-2.0` для отдельных крейтов — изучается строго на уровне архитектурных концепций без заимствования кода!).

---

### Домен 1: Агентное ядро, обработка `maxOutputTokens` + `thinking`, кэширование промптов и Swarm-оркестрация

#### Ключевые инсайты из открытых систем
- **OpenAI Codex CLI:** разделяет лимит контекста и динамический резерв выходных токенов; при работе с reasoning-моделями использует `max_completion_tokens`, где бюджет выхода включает и скрытые токены рассуждений, и видимый ответ/вызов инструмента. При получении `finish_reason: "length"` не парсит битый tool call как синтаксическую ошибку модели, а возвращает детерминированный системный сигнал усечения.
- **Cline / Roo Code / Kilo Code:** для OpenRouter инжектируют `cache_control: { type: "ephemeral" }` в системный блок и последние 2 пользовательских/инструментальных сообщения, извлекая статистику из `usage.prompt_tokens_details.cached_tokens`. В `WorktreeManager` изолируют параллельные задачи в отдельных git worktrees.
- **OpenHands:** применяет агрессивное **Observation Masking** (конденсацию старых крупных выводов чтения файлов и bash-команд в компактные ссылки-заглушки с сохранением хеша/пути и последних N ходов в полном виде), что удерживает рабочий контекст в диапазоне `40K–90K` токенов даже на задачах из 100+ шагов вместо раздувания до `444K` токенов, и не ломает префиксный prompt cache при скользящем окне breakpoints.

#### Сравнительная таблица (Домен 1)

| Решение / Система | Архитектура кэша, токенов и оркестрации | Обработка краевых случаев (`length`, `thinking`, гонки Swarm) | Лицензия и зрелость | Трудоёмкость интеграции и сопровождения в Zcode |
| --- | --- | --- | --- | --- |
| **Текущий Zcode (baseline)** | `@ai-sdk/*`, `CommandInbox`, субагенты делят общий `workspacePath` и `sharedReadFileState` | Падает с `Unexpected end of JSON input` на `16_384` токенах (`F-01`); `cacheReadTokens = 0` на OpenRouter (`F-04`); гонки записи субагентов (`F-02`) | `Apache-2.0` | Уже в ядре, требует целевой модернизации |
| **Kilo Code / Cline / Roo Code** | `addAnthropicCacheBreakpoints` (3 точки `ephemeral`), `verifyFinishReason`, `WorktreeManager` | Перехватывает `length`, но бросает фатальное исключение вместо self-healing ответа инструмента; белый список OpenRouter не включает `qwen/*` | `Apache-2.0` (Высокая) | **Низкая** (трансформер сообщений в `@zcode/adapters` + расширение `subagent/port.ts`) |
| **OpenAI Codex CLI** | Единый бюджет `thinking + tool_output`, детерминированное восстановление при усечении, изолированные воркеры | Корректно масштабирует `max_completion_tokens` под `reasoning_effort`, исключает цикл повторной записи огромного файла | `Apache-2.0` (Высокая) | **Низкая** (нативно ложится в `call-runner.ts` и `model-option-map`) |
| **OpenHands** | Observation Masking старых tool outputs + EventStream с строгой сериализацией мутаций | Удерживает стабильный размер контекста на моделях с окном 1M без потери истории решений | `MIT` (Высокая) | **Средняя** (интеграция в существующий `apps/zcode-cli/packages/core/src/compact/`) |

#### Архитектурный выбор для Zcode (Домен 1)
1. **Перехват `finishReason === "length"` до `JSON.parse` аргументов инструмента** в `apps/zcode-cli/packages/core` (`call-runner` / `turn.ts`): возвращать модели структурированный `tool_result` с кодом `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`, фактическим потолком `maxOutputTokens` и жёсткой директивой разбить генерацию на каркас (`Write`) + инкрементальные правки (`ApplyPatch` / `Edit`).
2. **Динамическое масштабирование выходного бюджета при `thinking`:** в `@zcode/adapters` / `@zcode/model-option-map` вычислять `effectiveMaxOutputTokens = min(modelHardMaxOutput, max(baseToolBudget=16384, thinkingBudgetTokens + minToolPayloadReserve=12288))` (с подъёмом дефолтного потолка для моделей Qwen3/Claude 4/Gemini 2.5/DeepSeek до `32_768–65_536`, где поддерживается провайдером).
3. **Универсальный `OpenRouterCacheControlTransformer`** в `@zcode/adapters`: для всех OpenRouter/совместимых эндпоинтов на моделях `anthropic/*`, `google/*`, `qwen/*` автоматически размечать `cache_control: { type: "ephemeral" }` на `system`, последнем определении resident-инструментов и 2 последних `user`/`tool` сообщениях, плюс маппить `prompt_tokens_details.cached_tokens → cacheReadTokens`.
4. **Двухуровневая координация Swarm-субагентов:** (а) внутрипроцессный `FileLockRegistry` (RW-блокировки с детекцией дедлоков и проверкой `writeScope` манифеста владения файлами) для быстрых параллельных субагентов в одном дереве + (б) опциональная `GitWorktreeIsolation` по паттерну `WorktreeManager.ts` (`.zcode/worktrees/<subagentId>` с записью в `.git/info/exclude`) для тяжёлых параллельных задач.
5. **Ранний Observation Masking** в `core/compact`: маскировать сырые простыни `Read`/`Bash`/`Grep` старше `N=6` ходов при превышении абсолютного порога `120_000` токенов (не дожидаясь 80% от 1M окна!), сохраняя путь, строки, хеш ревизии и компактную сводку с учётом выравнивания границ prompt-кэша.

---

### Домен 2: Мультифайловые транзакции, Diff-движок, AST-превалидация и реактивная синхронизация UI

#### Ключевые инсайты из открытых систем
- **OpenAI Codex CLI (`apply_patch`):** компактная мультифайловая грамматика (`Add`/`Delete`/`Update`/`Move` + контекстные ханки `@@`) экономит до **60–75% выходных токенов** по сравнению с `Write` и длинными `old_string`/`new_string`, не зависит от номеров строк и отлично генерируется не только GPT, но и Claude Sonnet/Opus, Qwen 3/3.6, DeepSeek V3/R1 и Gemini 2.5 при наличии чёткой схемы инструмента.
- **Kilo Code / Roo Code (`MultiSearchReplace` + `EditFileTool`):** эталонная относительная ре-индентация вставляемого блока (`indentedReplaceLines`), Middle-Out Levenshtein (`fastest-levenshtein`), `whitespaceTolerantRegex` (переживающий сдвиги пустых строк) и возврат `Best Match Found` с номерами строк при промахе.
- **Zed (концепция транзакций буферов `ProjectTransaction`):** все мультифайловые правки сначала применяются к in-memory снимкам буферов под захваченными блокировками, проходят быструю проверку инвариантов/синтаксиса (`tree.rootNode.hasError`), и только при 100% успехе всех файлов фиксируются атомарным коммитом (через временные файлы `.zcode- staging-*` + `rename` с журналом отката `UndoLog` для мгновенного восстановления при любом IO-сбое).

#### Сравнительная таблица (Домен 2)

| Решение / Система | Формат и алгоритм матчинга | Транзакционность, блокировки и валидация | Лицензия и зрелость | Трудоёмкость интеграции и сопровождения в Zcode |
| --- | --- | --- | --- | --- |
| **Текущий Zcode (`Edit` + закрытый `ApplyPatch`)** | `Edit` (8 матчеров без ре-индентации `new_string` и без пропуска пустых строк); `ApplyPatch` закрыт для не-GPT | Пофайловая запись без rollback пакета, без `FileLockRegistry` и без проверки синтаксиса (`F-03`, `F-07`) | `Apache-2.0` | Уже в ядре, есть готовый каркас `patch-parser.ts` / `patch-apply.ts` |
| **OpenAI Codex CLI (`apply_patch`)** | Мультифайловый `*** Begin Patch` + 4-проходный `seekSequence` (`exact → trimEnd → trim → unicode`) | Предварительная верификация всех ханков в памяти до записи на диск; нет встроенной AST-проверки | `Apache-2.0` (Высокая) | **Минимальная** (разблокировка и усиление уже существующего [apply-patch.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts#L34)) |
| **Kilo Code / Cline / Roo Code** | `SEARCH/REPLACE` с `:start_line:`, Middle-Out Levenshtein, ре-индентация `indentedReplaceLines`, `whitespaceTolerantRegex` | Отличное восстановление отступов и диагностика `Best Match Found`, но частичное применение без полного rollback | `Apache-2.0` (Высокая) | **Низкая** (интеграция алгоритмов ре-индентации и fuzzy-якорей в `edit-matchers.ts` и `patch-apply.ts`) |
| **Zed (архитектурный паттерн)** | Мультибуферные диапазонные транзакции с реактивной проекцией диффов в UI | Полная атомарность пакета, проверка синтаксического дерева Tree-sitter (`hasError`), чистый undo/redo | Концепция (код `GPL-3.0` **не используется**) | **Средняя** (проектируем собственный чистый `WorkspaceEditTransactionManager` под `Apache-2.0`) |

#### Архитектурный выбор для Zcode (Домен 2)
1. **Разблокировать `ApplyPatch` для всех coding-моделей** (Qwen, Claude, DeepSeek, Gemini, OpenAI, GLM) как основной мультифайловый/многоханковый инструмент, дополнив [patch-apply.ts](../../apps/zcode-cli/packages/core/src/tool/patch-apply.ts#L70) 5-м проходом **Indentation-Preserving Fuzzy Match** (с относительным пересчётом отступов `reindentReplacementLines`).
2. **Модернизировать [edit-matchers.ts](../../apps/zcode-cli/packages/core/src/tool/edit-matchers.ts#L41) и [edit.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/edit.ts#L214):**
   - добавить обязательную **относительную ре-индентацию `new_string`** при срабатывании `indentation_flexible` и `line_trimmed`;
   - добавить стратегию `blank_line_tolerant` (нормализация пустых строк внутри блока) и эластичный поиск закрывающего якоря в `block_anchor` (допуская `±3` строки разницы длины блока с порогом схожести `>= 0.82`);
   - защитить замену от спецсимволов `$` и при `OLD_STRING_NOT_FOUND` возвращать `Best Match Snippet` с реальными номерами строк вокруг лучшего кандидата (`±15` строк), избавляя модель от лишнего `Read`.
3. **Внедрить `WorkspaceTransactionCoordinator` в `@zcode/core` / `@zcode/adapters`:**
   - **Фаза 1 (`Acquire & Prepare`):** лексикографически отсортированный захват эксклюзивных блокировок путей в `FileLockRegistry` (исключает deadlock между субагентами!), чтение файлов, проверка `expectedRevision`, расчёт `newContent` в памяти для *всех* файлов транзакции.
   - **Фаза 2 (`Syntax / AST Pre-validation`):** быстрая проверка валидности нового содержимого (`JSON.parse` для `.json`, встроенный `meriyah` / `ts` для JS/TS и `web-tree-sitter` `rootNode.hasError` для Python/Go/Rust/C++/Java и др. — с проверкой, что число синтаксических ошибок `ERROR`/`MISSING` не выросло относительно исходного файла!). Если файл сломан — транзакция либо отклоняется (в строгом режиме), либо помечается мгновенным диагностическим предупреждением с точной строкой/колонкой синтаксической ошибки прямо в ответе инструмента!
   - **Фаза 3 (`Atomic Commit / Rollback`):** запись во временные файлы в целевых директориях, сохранение in-memory/artifact backup старых состояний и атомарный `rename`; если любая операция записи падает — мгновенный полный откат всех затронутых файлов транзакции к исходным байтам и `mtime`.
4. **Реактивная синхронизация активных диффов:** публикация событий транзакции (`transaction.staged`, `transaction.committed`, `transaction.rolledBack`) с унифицированной сводкой `FileChangeSummary` в `TaskRealtimeBus` (`desktop-continuous`) и компактной дельтой в пределах байтового бюджета снимка для `web-remote-replayable`.

---

### Домен 3: Кодовая индексация (`web-tree-sitter` AST + Граф символов PageRank + Гибридный поиск FTS5 BM25 / Vector / RRF)

#### Ключевые инсайты из открытых систем
- **Aider (`RepoMap`):** использует запросы `tree-sitter` (`tags.scm`: `@definition.*` и `@reference.*`) для построения двудольного мультиграфа файлов и идентификаторов, после чего запускает **персонализированный PageRank** (с повышенным весом файлов, упомянутых в запросе пользователя или открытых в сессии, и понижающим коэффициентом на частотные утилитарные имена и тестовые файлы). Это позволяет уложить самую важную архитектурную карту репозитория в `1 000 – 2 000` токенов!
- **Continue (`CodebaseIndexer` + Hybrid Retrieval):** комбинирует полнотекстовый индекс **SQLite `FTS5` (`bm25()`)** с триграммным/лексическим поиском, векторный поиск эмбеддингов, точное совпадение путей/символов и объединяет ранжированные списки через **Reciprocal Rank Fusion (`RRF`, `score = Σ w_i / (k + rank_i)`, `k = 60`)** с последующим токен-бюджетным пакетированием и слиянием пересекающихся диапазонов строк (`mergeSnippetsByRange`, разобранный нами в `continuedev/core/autocomplete/context/ranking/index.ts:78–104`).
- **Kilo Code (`CodeParser` + `web-tree-sitter`):** проверенный в Electron WASM-пайплайн для 25+ языков с умным структурным чанкером по AST-узлам и ребалансировкой остатка.

#### Сравнительная таблица (Домен 3)

| Решение / Система | Парсинг языков и граф | Движок поиска и хранение | Лицензия и зрелость | Трудоёмкость интеграции и сопровождения в Zcode |
| --- | --- | --- | --- | --- |
| **Текущий Zcode (`CodeIntelligenceService`)** | Только JS/TS (`ts.createSourceFile`), слеп к Python/Rust/Go; наивные чанки по 120 строк | `node:sqlite`, но `LIKE '%t%' LIMIT 1001` без `FTS5`, строковые ключи (`527 МБ` БД!), `Recall@4 = 0.20`, режет JSON на 24 КБ (`F-05`) | `Apache-2.0` | Уже в Local Host (`packages/services/src/code-intelligence`) |
| **Kilo Code (`code-index` + `tree-sitter`)** | `web-tree-sitter` + 28 запросов + Markdown секции, структурный AST-чанкинг; графа вызовов нет | Qdrant или динамический `@lancedb/lancedb` (N-API); без эмбеддингов поиск мёртв | `Apache-2.0` + `MIT` (`web-tree-sitter`) | **Низкая** для парсера/чанкера; LanceDB N-API избыточен для Zcode |
| **Aider (`RepoMap`)** | `tree-sitter` `defs` + `refs`, взвешенный граф файлов и символов + PageRank | Кэш тегов в SQLite; не решает полнотекстовый и семантический поиск тела функций | `Apache-2.0` (Высокая) | **Низкая** (алгоритм степенных итераций PageRank занимает ~80 строк чистого TS поверх таблиц `symbols`/`edges` Zcode!) |
| **Continue (SQLite FTS5 + Vector + RRF)** | Tree-sitter AST чанкинг + индекс путей | SQLite `FTS5` (`bm25`) + векторы + `RRF (k=60)` + слияние соседних чанков и токен-бюджетирование | `Apache-2.0` (Высокая) | **Низкая** (`node:sqlite` в Node 24 уже имеет `fts5Supported: true`!) |

#### Архитектурный выбор для Zcode (Домен 3)
Синтезируем **единый высокопроизводительный движок `CodeIntelligenceService v2`** на базе уже встроенного `node:sqlite` (вынесенного в отдельный **`node:worker_threads` Worker**, чтобы `0 мс` блокировать event loop Local Host!):
1. **Мультиязычный AST-парсер и чанкер на `web-tree-sitter` (`MIT`):**
   - Поддержка JS/TS/TSX, Python, Go, Rust, C/C++, C#, Java, Kotlin, Ruby, PHP, Swift, SQL, Bash, TOML, YAML, JSON, HTML/CSS/Vue и секционного Markdown.
   - Структурный AST-чанкинг по алгоритму `kilocode-legacy-main` (`parser.ts`: границы классов/функций/методов, `50..1150` симв., ребалансировка хвоста `>= 200` симв., инъекция шапки области видимости `// File: path | Scope: ClassName.methodName` в индексируемый текст чанка для резкого роста точности BM25 и эмбеддингов!).
   - **Лицензионный фильтр `.wasm`-грамматик:** включать только грамматики под `MIT` / `Apache-2.0` / `BSD` / `ISC` (исключить любые `GPL`/`LGPL` грамматики, например `elisp` при несовместимой лицензии апстрима, оставив для них текстовый fallback-чанкер).
2. **Компактная целочисленная схема SQLite + WAL + `FTS5` (сокращение БД с `527 МБ` до `~55–80 МБ`):**
   - Заменить текстовые PK/FK `s:<path>:<line>:<kind>:<name>` на `INTEGER PRIMARY KEY` (`file_id`, `symbol_id`, `chunk_id`) с нормализованной таблицей `files(id, rel_path, content_hash, mtime_ms, is_test, pagerank)`.
   - Создать виртуальную таблицу **`chunks_fts USING fts5(path_tokens, symbol_names, content, tokenize='unicode61 tokenchars ''_-''')`** с кастомным пред-разбиением `camelCase` / `snake_case` идентификаторов (`createCodeIntelligenceService → create Code Intelligence Service + createCodeIntelligenceService`), взвешенным `bm25(chunks_fts, 4.0, 6.0, 1.0)`!
3. **Граф символов + PageRank (по методу Aider `RepoMap`):**
   - Извлекать `@definition.*` и `@reference.*` / `@call.*` через Tree-sitter для всех основных языков, считать `pagerank` файлов за 15 степенных итераций (`damping = 0.85`) после индексации и сохранять в `files.pagerank`.
4. **Четырёхканальный гибридный поиск с `RRF` и структурным бюджетированием:**
   - **Канал 1:** `Exact / Prefix Symbol & Path Match` (по B-tree индексам `symbols(name)` и `files(rel_path)`);
   - **Канал 2:** `SQLite FTS5 BM25` (с `AND` → fallback `OR` на значимых термах со стоп-словами);
   - **Канал 3:** `Graph Neighborhood / PageRank Boost` (подъём центральных модулей и соседей по импортам/вызовам);
   - **Канал 4:** `Quantized Vector Cosine Search` (при настроенном провайдере эмбеддингов — хранение типизированных `Float32Array` / скалярно квантованных `Int8Array` векторов с быстрым линейным проходом в Worker Thread без лишних аллокаций JS-объектов).
   - **Слияние:** взвешенный `Reciprocal Rank Fusion (k = 60)` + **мультипликативная пенализация тестов/фикстур (`×0.35` для `*.test.*`, `*.spec.*`, `__tests__/`, `fixtures/`, `.agents/skills/`)**, если сам запрос явно не ищет тесты!
   - **Структурное бюджетирование ответа `CodeIndex`:** полностью убрать побайтовый `strategy: "truncate"` посередине JSON ([code-index.ts](../../apps/zcode-cli/packages/core/src/tool/handlers/code-index.ts#L38)); формировать компактный валидный ответ в рамках токен/байт-бюджета поэлементно со слиянием смежных чанков одного файла (`mergeSnippetsByRange`).
5. **Наблюдение за файлами без исчерпания `inotify` на Linux и автостарт первичного индекса:**
   - Первичное сканирование путей через уже поставляемый с Zcode сверхбыстрый нативный **`bfs` (`0BSD`) / `ripgrep --files` (`MIT`)** вместо рекурсивного JS `readdir`;
   - Наблюдение через уже установленный в `@zcode/services` **`chokidar@4.0.3` (`MIT`)** с жёстким `ignored` до спуска в `node_modules`/`.git`/`dist` и инкрементальным обновлением рёбер *только изменённых файлов*;
   - Автоматический фоновый старт первичной индексации с низким приоритетом в Worker Thread при открытии workspace (с порогами безопасности для гигантских директорий).

---

### Домен 4: SOTA системные промпты и интеллектуальный `Enhance Prompt`

#### Ключевые инсайты из открытых систем
- **OpenAI Codex CLI & Claude Code / OpenHands:** компактное, модульное ядро системного промпта (`~4K–7K` токенов вместо рыхлых повторов), жёстко разделённое на **статический кэшируемый префикс** (роль, когнитивный цикл, инварианты инструментов) и **динамическое сообщение напоминаний хода** (`<system-reminder>`), чтобы никогда не инвалидировать кэш системного промпта!
- **Когнитивный протокол SOTA coding-агентов:** явный 4-фазный цикл для нетривиальных задач: `1. Context & Search (CodeIndex/Grep перед догадками) → 2. Invariants & Edge Cases (типы, границы, конкурентность) → 3. Minimal Atomic Edit (ApplyPatch/Edit вместо полного Write) → 4. Verification & Self-Check (typecheck/test/diagnostics перед финальным ответом)`.
- **Kilo Code (`MessageEnhancer`) + Continue Context Providers:** лучший UX улучшения промпта объединяет мгновенный сбор локального контекста проекта (`package.json`/стек, активные `@mentions`, топ-4 релевантных символа/файла из `CodeIndex` FTS5 за `<25 мс`, последние реплики диалога) со структурирующим мета-промптом, потоковым выводом в композер, кнопкой отмены (`AbortController`) и кнопкой возврата к исходному тексту (`Undo`).

#### Сравнительная таблица (Домен 4)

| Решение / Система | Архитектура системного промпта | Архитектура `Enhance Prompt` | Лицензия и зрелость | Трудоёмкость интеграции и сопровождения в Zcode |
| --- | --- | --- | --- | --- |
| **Текущий Zcode** | `14K–20.5K` токенов на холодном старте, реестр `config/prompts/registry.json` | **Полностью отсутствует** (`0` вхождений в UI/RPC/Services) | `Apache-2.0` | Базовый реестр и `prompt:check` уже есть |
| **Kilo Code / Roo Code** | Модульная сборка по `Mode` (`architect`, `code`, `debug`), но большой объём при XML-описаниях | `MessageEnhancer` (отдельный профиль модели + история 10 сообщений + сохранение Undo в UI) | `Apache-2.0` (Высокая) | **Низкая** (отличный референс RPC/UI цикла, но мета-промпт нужно усилить контекстом индекса) |
| **Codex CLI / OpenHands** | Компактный стабильный системный префикс + строгий когнитивный цикл верификации и работы малыми патчами | Нет отдельной UI-кнопки улучшения промпта | `Apache-2.0` / `MIT` | **Низкая** (обновление шаблонов в `apps/zcode-cli/packages/core/src/prompt/` с синхронизацией `prompt:snapshot`) |

#### Архитектурный выбор для Zcode (Домен 4)
1. **Дедупликация и когнитивное усиление системного промпта Zcode:** выделить 100% детерминированный статический префикс (для максимального cache hit rate) и внедрить компактный протокол `Explore (CodeIndex/Grep) → Plan Invariants → Surgical Patch (ApplyPatch/Edit) → Verify`, а также правило запрета монолитного `Write` для крупных файлов (`> 300` строк) в пользу поэтапного каркаса + `ApplyPatch`.
2. **Полноценный `PromptEnhancerService` в `@zcode/services` + RPC в `@zcode/shared` + кнопка `WandSparkles` / `/enhance` в `@zcode/ui`:**
   - Собирает за `< 40 мс` легковесный паспорт workspace (языки/манифесты, разрешённые `@file` чипы из `LexicalChatInput`, топ-3 релевантных файла/символа из `CodeIndex` FTS5, последние 6 сообщений текущей задачи).
   - Поддерживает выбор выделенной быстрой модели в `SettingsPage` (с fallback на модель активной сессии), потоковую передачу или быстрый `AbortSignal`, сохранение точного сериализованного состояния Lexical (`PromptMentionNode` чипы не теряются!) в стек возврата `Undo Enhance`.

---

### Домен 5: ОС-песочница, интерактивный PTY, Playwright с замкнутой телеметрией и нативный Linux/macOS Computer Use

#### Ключевые инсайты из открытых систем и аудит локальной Linux-среды
- **OpenAI Codex CLI (OS Sandbox + Interactive PTY):**
  - **На Linux:** оборачивает исполняемые команды агента в непривилегированный **`bubblewrap` (`bwrap`)**: монтирует корневую ФС только для чтения (`--ro-bind / /`), монтирует `workspacePath` и `/tmp` на запись (`--bind <workspace> <workspace>`, `--tmpfs /tmp`), маскирует чувствительные каталоги (`~/.ssh`, `~/.gnupg`, `~/.aws`, `.git/hooks` на ro), изолирует PID namespace (`--unshare-pid`, `--die-with-parent` — гарантированно убивает всё дерево дочерних процессов при завершении/таймауте!) и при запрете сети добавляет `--unshare-net`!
  - **На macOS:** применяет системный `/usr/bin/sandbox-exec -p <seatbelt-profile>` (`(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ...))`).
  - **Интерактивный PTY:** предоставляет агенту пару инструментов `exec_command` (запуск в PTY с возвратом `session_id`, если процесс ждёт ввода или продолжает работать) + `write_stdin` (отправка клавиш/ответа или пустой опрос вывода живой PTY-сессии).
- **OpenHands (Closed-Loop Browser & Runtime Self-Healing):** каждое браузерное действие (`click`, `fill`, `goto`) возвращает не просто «успех», а **единый пакет наблюдения (`ActionObservation`)**: компактное дерево доступности (ARIA DOM snapshot), дельту `console.error` / `console.warn`, непойманные исключения `pageerror`, неуспешные сетевые запросы (`requestfailed` и ответы `HTTP >= 400` на XHR/fetch!) и компактный WebP-скриншот при визуальном изменении или ошибке. Агент мгновенно видит стектрейс упавшего React-компонента или `500 Internal Server Error` бэкенда без ручного чтения логов!
- **Инструментальная проверка текущей Linux-машины разработчика (`/var/lib/dpkg/status`, `/usr/bin`, `/proc/sys/kernel`):**
  - ОС: `Linux Mint 22.3 (Ubuntu 24.04 Noble)`, ядро `6.14`, окружение `Cinnamon / Muffin (Xorg)` + установленный `grim` и `xdg-desktop-portal`.
  - **`/usr/bin/bwrap` (`bubblewrap`) и `/usr/bin/unshare` УСТАНОВЛЕНЫ**, `kernel.apparmor_restrict_unprivileged_userns = 0`! (При этом на стоковой Ubuntu 24.04, где этот флаг равен `1` без профиля AppArmor, песочница должна делать самопроверку пробным `bwrap --ro-bind / / true` при старте и иметь чистый режим деградации/предупреждения).
  - **КРИТИЧЕСКИЙ ФАКТ ДЛЯ LINUX COMPUTER USE:** пакеты `xdotool`, `ydotool`, `scrot`, `xvfb` **НЕ УСТАНОВЛЕНЫ** на десктопной системе по умолчанию! Зато **УСТАНОВЛЕНЫ** системные библиотеки `libX11.so.6` (`libx11-6`), `libXtst.so.6` (`libxtst6` — расширение XTest для аппаратно-независимого синтеза движений мыши, кликов и нажатий клавиш!), `libXext.so.6`, утилиты `wmctrl`, `xprop` (`x11-utils`), `gnome-screenshot`, `grim`, `at-spi2-core`, а в самом репозитории Zcode ([apps/zcode-cli/packages/adapters/package.json](../../apps/zcode-cli/packages/adapters/package.json#L120)) **УЖЕ УСТАНОВЛЕН `koffi@2.15.6` (`MIT`)**!

#### Сравнительная таблица (Домен 5)

| Подсистема / Вариант | Архитектура исполнения | Краевые случаи на Linux и macOS | Лицензия | Трудоёмкость и стоимость сопровождения в Zcode |
| --- | --- | --- | --- | --- |
| **Песочница Bash: OpenAI Codex CLI подход (`bwrap` + `sandbox-exec`)** | Linux: `/usr/bin/bwrap` (`--ro-bind / /`, `--bind workspace`, `--die-with-parent`, опц. `--unshare-net`); macOS: `/usr/bin/sandbox-exec` Seatbelt | Проверяет `apparmor_restrict_unprivileged_userns` при старте; `--die-with-parent` навсегда решает зомби-процессы дерева! | Системные бинарники ОС (`spawn`), код адаптера `Apache-2.0` | **Низкая** (встраивается прямо в `NodeExecutionAdapter` / `bash.ts` вместо `"not_implemented"`) |
| **Агентный PTY: `node-pty` сессионный пул (Codex / OpenHands паттерн)** | Переиспользует уже установленный в Zcode `node-pty@1.0.0` (`@lydell/node-pty-linux-*`) с кольцевым буфером ANSI-strip и контролем дерева PGID | Поддерживает интерактивные CLI, REPL, пароли/подтверждения, dev-серверы с чтением живых логов | `MIT` (уже в `package.json` Zcode!) | **Низкая** (без новых нативных зависимостей) |
| **Linux CUA Вариант А: только внешние CLI (`xdotool` + `scrot`)** | Вызов `spawn("xdotool")` / `spawn("scrot")` | **Сломается из коробки на текущей машине** (пакеты не предустановлены в Mint/Ubuntu!), не работает на чистом Wayland | Внешние CLI (`BSD` / `MIT`) | Низкая разработка, но **плохой UX из коробки** (требует `sudo apt install`) |
| **Linux CUA Вариант Б (Гибридный нативный): `Electron desktopCapturer / Portal` + `koffi(libX11 + libXtst)` + CLI fallback** | Скриншоты: Electron `desktopCapturer` / `gnome-screenshot` / `grim` / X11 `XGetImage` + ресайз через `jimp`; Ввод X11: прямой вызов `libX11.so.6` + `libXtst.so.6` через уже установленный `koffi` (с опциональным ускорителем `xdotool`/`ydotool`/Wayland `RemoteDesktop` Portal) | **100% работает из коробки на текущей машине и в Docker E2E (`libxtst6` уже в `Dockerfile.desktop-e2e`!)** без `root` и без доустановки пакетов; на macOS сохраняется штатный `ZCode Computer Use.app` Helper | `MIT` (`koffi`, `jimp`) + `Apache-2.0` | **Средняя**, нулевые проблемы пересборки C++ аддонов под Electron |
| **Browser Use: Stateful SDK + Auto-Telemetry (OpenHands паттерн)** | Постоянный контекст `browser` в REPL + кольцевой перехватчик `console.error`, `pageerror`, `HTTP >= 400`, `requestfailed` + ARIA snapshot + WebP screenshot | Мгновенное самовосстановление агента при ошибках фронтенда/API без 12 строк boilerplate-импорта на каждый ход | `Apache-2.0` (`playwright-core` уже в Zcode) | **Низкая** |

#### Архитектурный выбор для Zcode (Домен 5)
1. **Двухплатформенная ОС-песочница (`SandboxExecutor`):** `bubblewrap` (`bwrap`) на Linux + `sandbox-exec` (Seatbelt) на macOS с политиками `workspace-write` (по умолчанию: чтение системы, запись только в `workspacePath`, `$TMPDIR` и разрешённые кэши пакетных менеджеров, защита `.git/hooks` и `~/.ssh`, `--die-with-parent`) и `strict-offline` (`--unshare-net`), плюс автоматический capability-probe при старте сессии.
2. **Контролируемый интерактивный PTY для агента:** пул PTY-сессий на базе уже встроенного `node-pty` с лимитом активных сессий, очисткой управляющих последовательностей, отслеживанием дерева процессов (`processTreeTerminator`) и инструментальными операциями запуска/ввода/опроса/завершения.
3. **Нативный Linux + macOS Computer Use (`@zcode/zcode-cua` + `cua-helpers.ts`):** снять блокировку `platform === "darwin" || platform === "win32"` ([cua-helpers.ts](../../packages/services/src/node/cua-helpers.ts#L65)), реализовав для Linux двухрежимный адаптер (`X11` через `koffi` к `libX11.so.6` + `libXtst.so.6` и `wmctrl`/`xprop`, `Wayland` через `org.freedesktop.portal.RemoteDesktop` / `Screenshot` / `grim` / `ydotool` + захват кадров Electron `desktopCapturer` и масштабирование координат под DPI дисплея) с панелью индикации и мгновенного перехвата управления пользователем (`Escape` / кнопка Stop).
4. **Замкнутый контур самовосстановления Playwright / Browser Use:** предзагруженный объект браузерной сессии без повторного холодного импорта + автоматический сбор буфера `console.error`, `pageerror`, сетевых отказов `4xx/5xx`/`CORS` и ARIA-снимка в каждый ответ браузерного действия.

---

### Домен 6: Предиктивное автодополнение `LexicalChatInput` (`Ghost-Text`) и унификация системы настроек

#### Ключевые инсайты из открытых систем
- **Lexical Official Playground (`AutocompletePlugin` / `AutocompleteNode`, `MIT`) & Zed Composer:** в отличие от `<textarea>` в `kilocode-legacy-main` (где приходится накладывать прозрачный `div`-зеркало и бороться с прыжками скролла, переносами строк и inline-чипами упоминаний!), в **Lexical 0.42** (уже установленном в [packages/ui/package.json](../../packages/ui/package.json#L66)) inline ghost-text реализуется **кастомным узлом `GhostTextNode` (наследником `TextNode` / `DecoratorNode` с `isInline() = true`, `excludeFromCopy() = true` и запретом сериализации в `getEditorMarkdown()`)**!
  - Это даёт идеальное попиксельное совпадение базовой линии даже в строке, где стоят inline-чипы [PromptMentionNode.ts](../../packages/ui/src/mentions/nodes/PromptMentionNode.ts#L49), поддержку многострочного переноса длинной подсказки, нулевой сдвиг скролла и невмешательство в стек `HistoryPlugin` (при обновлении с тегом `history-merge` / `PROGRAMMATIC_UPDATE_TAG`)!
- **Kilo Code (`useChatAutocompleteText` + `ChatTextAreaAutocomplete`):** берём трёхрежимный префиксный кэш (`exact`, `partial_typing`, `backward_deletion`), адаптивный дебаунс `200–350 мс`, `removePrefixOverlap`, принятие всей фразы по `Tab`, одного слова по `ArrowRight` и скрытие по `Escape`, дополняя сквозным **`AbortController`** через RPC.

#### Сравнительная таблица (Домен 6)

| Решение / Вариант | Способ рендера Ghost-Text в редакторе | Конфликты с IME, `@mentions`, `/` и историей `Undo` | Лицензия | Трудоёмкость и сопровождение в Zcode |
| --- | --- | --- | --- | --- |
| **Зеркальный HTML-слой (`kilocode-legacy-main` `ChatTextArea.tsx`)** | Абсолютно позиционированный `<div ref={highlightLayerRef}>` под `<textarea>` | В Lexical с inline-чипами `PromptMentionNode` даёт рассинхрон ширины чипов и переносов строк | `Apache-2.0` | Высокая хрупкость верстки на Desktop + Mobile |
| **CSS `::after` `data-ghost-text` на DOM-элементе параграфа** | Атрибут на `<p>` + псевдоэлемент `::after { content: attr(data-ghost-text) }` | Очень быстро и не трогает дерево Lexical, но работает только когда курсор в самом конце последнего параграфа | `Apache-2.0` | **Минимальная**, но требует аккуратной привязки к последнему текстовому узлу |
| **Нативный Lexical `GhostTextNode` + `GhostAutocompletePlugin` (Lexical / Zed паттерн)** | Специализированный inline-узел Lexical с `PROGRAMMATIC_UPDATE_TAG`, исключённый из `getEditorMarkdown` и буфера обмена | Идеальная верстка рядом с `PromptMentionNode`, полная защита IME (`event.isComposing`), чистый `Undo`, приоритет ниже `SlashCommandPlugin` / `MentionPlugin` | `MIT` (`lexical` уже в Zcode) | **Низкая**, 100% нативно для архитектуры [LexicalChatInput.tsx](../../packages/ui/src/LexicalChatInput.tsx#L48) |

#### Архитектурный выбор для Zcode (Домен 6)
1. **Нативный `GhostTextNode` + `ChatAutocompletePlugin` для [LexicalChatInput.tsx](../../packages/ui/src/LexicalChatInput.tsx#L148):**
   - Команды `KEY_TAB_COMMAND` (`COMMAND_PRIORITY_LOW` — автоматически уступает `COMMAND_PRIORITY_HIGH` открытых меню `/` и `@`!), `KEY_ARROW_RIGHT_COMMAND` (пословное принятие) и `KEY_ESCAPE_COMMAND` (сброс ghost-узла без очистки текста).
   - Полное отключение во время IME-композиции (`isComposing`), на мобильных сенсорных экранах без физической клавиатуры (или показ компактного тап-чипа), при пустом вводе `< 4` символов и при вводе секретов.
   - На стороне `@zcode/services`: `ChatCompletionService` с кольцевым префиксным кэшем (`exact` / `partial_typing` / `backward_deletion`), `AbortController` на каждый новый запрос, жестким бюджетом `maxOutputTokens: 32`, `reasoningEffort: "none"`, контекстом активной задачи (последние сообщения + открытые файлы / `CodeIndex` символы).
2. **Унификация системы настроек (`SettingService` ↔ `zcode-cli`):**
   - Расширить единую схему `AppSettings` в `@zcode/shared` типизированными секциями: `codeIndex` (автоиндексация, языки, гибридный поиск, лимиты), `promptEnhancer` (вкл/выкл, профиль быстрой модели, включение контекста индекса и истории), `chatAutocomplete` (вкл/выкл, профиль модели, задержка дебаунса), `sandboxAndCua` (режим песочницы `off | workspace-write | strict-offline`, интерактивный PTY, Linux/macOS CUA и телеметрия браузера).
   - Обеспечить реактивную синхронизацию этих настроек из `ISettingService` ([settingService.ts](../../packages/services/src/setting/settingService.ts#L224)) в `zcode-cli` при старте и горячем обновлении конфигурации без рассинхронизации `dataBaseDir`.

---

## 3. Аудит локального окружения, зависимостей монорепозитория и лицензионной совместимости

### 3.1. Проверка уже установленных в монорепозитории Zcode пакетов (нулевые лишние зависимости)

Аудит `package.json` всех пакетов Zcode показал, что **90% необходимого фундамента уже установлено и прошло корпоративный аудит лицензий**:

| Пакет / Инструмент в Zcode | Где установлен | Версия | Лицензия | Роль в целевой архитектуре модернизации |
| --- | --- | --- | --- | --- |
| `node:sqlite` (`DatabaseSync` + `FTS5`) | Встроен в `Node.js` ([mise.toml](../../mise.toml#L2)) | `24.14.0` | `MIT` (Node.js) / Public Domain (SQLite) | Хранилище `CodeIntelligenceService v2` в Worker Thread с полнотекстовым индексом **FTS5 BM25** |
| `bfs`, `ripgrep`, `ugrep` | Предсобраны в [native-search-tools-config.mjs](../../scripts/native-search-tools-config.mjs#L40) | `4.1.1` / `14.1.1` / `7.8.4` | `0BSD` / `MIT` / `BSD-3-Clause` | Сверхбыстрый обход дерева файлов и точный поиск без рекурсивного JS `readdir` |
| `chokidar` & `ignore` | `@zcode/services` | `4.0.3` / `^5.3.2` | `MIT` / `MIT` | Кроссплатформенный файловый наблюдатель с фильтрацией `node_modules`/`.git` до постановки `inotify` watch |
| `node-pty` + `@lydell/node-pty-linux-*` | `@zcode/services`, `@zcode/desktop` | `^1.0.0` / `1.2.0-beta.10` | `MIT` | Пул контролируемых интерактивных PTY-сессий для агента |
| `playwright-core` | `@zcode/desktop`, `@zcode/adapters` | `1.59.1` | `Apache-2.0` | Браузерная автоматизация с замкнутым контуром сбора `console.error`, `pageerror`, `HTTP 4xx/5xx` и ARIA |
| `koffi` | `@zcode/adapters` | `2.15.6` | `MIT` | Прямой C FFI вызов системных `libX11.so.6` + `libXtst.so.6` для нативного Linux Computer Use без C++ пересборок |
| `jimp` | `@zcode/adapters` | `^1.6.1` | `MIT` | Быстрое масштабирование и сжатие скриншотов CUA под координатную сетку модели |
| `diff` & `@pierre/diffs` | `@zcode/core`, `@zcode/bootstrap`, `@zcode/ui` | `^9.0.0` / `^1.1.22` | `BSD-3-Clause` / `MIT` | Генерация структурированных унифицированных патчей и рендеринг диффов в Desktop/Web |
| `meriyah` & `typescript` | `@zcode/core`, `@zcode/services` | `^7.1.1` / `^6.0.2` | `ISC` / `Apache-2.0` | Мгновенная in-memory превалидация синтаксиса JS/TS при записи файлов |
| `lexical`, `@lexical/react`, `@lexical/plain-text` | `@zcode/ui` | `^0.42.0` | `MIT` | Реализация `GhostTextNode`, `ChatAutocompletePlugin` и безопасной замены текста `Enhance Prompt` |

### 3.2. Новые зависимости, отбираемые для включения в Zcode, и их лицензионный аудит

Для закрытия мультиязычного AST-парсинга и сверхбыстрого расчёта расстояния Левенштейна требуется минимальное, хирургически выверенное пополнение зависимостей:

| Добавляемый пакет | Целевой пакет Zcode | Лицензия | Совместимость с `Apache-2.0` Zcode | Примечание по безопасности и сборке |
| --- | --- | --- | --- | --- |
| `web-tree-sitter` (`^0.25.6`) | `@zcode/services` (и при необходимости AST-валидации `@zcode/adapters`) | **`MIT`** | **100% совместима** | Чистый JS + WASM рантайм, не зависит от ABI Electron vs системного Node 24, работает в Worker Thread и SEA |
| Курируемый бандл `.wasm`-грамматик (`tree-sitter-wasms` / официальные грамматики `python`, `go`, `rust`, `cpp`, `c`, `c_sharp`, `java`, `kotlin`, `ruby`, `php`, `typescript`, `tsx`, `javascript`, `bash`, `json`, `toml`, `yaml`, `html`, `css`, `sql`) | `@zcode/services` (`extraResources` / `bundled-tools`) | **`MIT` / `Apache-2.0` / `BSD-3-Clause` / `ISC`** | **100% совместима** | **Строгое правило:** перед упаковкой каждая включаемая `.wasm`-грамматика сверяется по SPDX-лицензии её апстрим-репозитория; грамматики под GPL/LGPL в сборку Zcode **не включаются** и обновляют `THIRD-PARTY-NOTICES.md` |
| `fastest-levenshtein` (`^1.0.16`, опционально — либо оптимизированный Myers bit-parallel Levenshtein в `@zcode/core`) | `@zcode/core` | **`MIT`** | **100% совместима** | Ускоряет Middle-Out нечёткий поиск больших блоков в 8–15 раз по сравнению с наивным ДП в `edit-matchers.ts:341` |

### 3.3. Карта системных возможностей целевой Linux-машины (`Linux 6.14`, `Mint 22.3 / Ubuntu 24.04`)

Инструментальная ревизия пакетов (`/var/lib/dpkg/status`, `/usr/bin`, `/proc/sys/kernel`) и контейнера [Dockerfile.desktop-e2e](../../Dockerfile.desktop-e2e#L28) подтвердила:
- **Изоляция процессов и ФС:** `/usr/bin/bwrap` (`bubblewrap`, внешняя системная утилита ОС, вызываемая через `execFile`/`spawn`) и `/usr/bin/unshare` (`util-linux`) присутствуют из коробки; `/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 0`. Для машин со значением `1` закладывается стартовый self-test `bwrap` с понятной диагностикой в `SettingsPage → Sandbox`.
- **Графическая подсистема и Linux Computer Use:** установлены `xorg`, `cinnamon`/`muffin`, `libx11-6` (`libX11.so.6`), `libxtst6` (`libXtst.so.6`), `libxext6`, `x11-utils` (`xprop`, `xwininfo`), `wmctrl`, `gnome-screenshot`, `grim`, `at-spi2-core`, `gir1.2-atspi-2.0`. Внешние утилиты `xdotool`, `ydotool`, `scrot`, `xvfb` по умолчанию отсутствуют на хосте (хотя `xvfb` и `libxtst6` присутствуют в `Dockerfile.desktop-e2e`). Следовательно, выбор связки **`Electron desktopCapturer / XDG Desktop Portal` + прямой FFI `koffi(libX11 + libXtst)` на X11/XWayland + D-Bus Portal / `grim` на Wayland** является единственным решением, гарантирующим 100% работу Linux Computer Use сразу после запуска без доустановки системных пакетов.

---

## 4. Сводный реестр утверждённых архитектурных решений для Этапа 3 (Проектирование и реализация)

| № | Подсистема Zcode | Выбранная эталонная архитектура (синтез лучших решений) | Основные референсы для адаптации |
| --- | --- | --- | --- |
| **1** | **Агентный цикл, `maxOutputTokens` и Prompt Caching** | До-парсинговый перехват `finishReason === "length"` с self-healing инструкцией декомпозиции; авто-масштабирование `maxOutputTokens` под `thinking`; `OpenRouterCacheControlTransformer` (`ephemeral` на `system` + `tools` + 2 последних `user`/`tool` для Claude/Gemini/Qwen) + ранний `Observation Masking` на `120K` токенов | `kilocode-legacy-main`: `caching/kilocode.ts`, `openrouter.ts`, `verifyFinishReason.ts`, `condense/index.ts` + паттерны Codex CLI и OpenHands |
| **2** | **Мультифайловые транзакции и Diff-движок** | Разблокировка `ApplyPatch` для всех coding-моделей; добавление относительной ре-индентации `reindentReplacement`, `blank_line_tolerant`, эластичного `block_anchor` и диагностики `Best Match` в `Edit` и `ApplyPatch`; двухфазный `WorkspaceTransactionCoordinator` (`FileLockRegistry` + AST/Syntax pre-check + atomic temp-rename commit & full rollback) + опциональная `GitWorktreeIsolation` для Swarm | `kilocode-legacy-main`: `multi-search-replace.ts`, `EditFileTool.ts`, `apply-patch/*`, `WorktreeManager.ts` + транзакционная модель буферов |
| **3** | **Кодовый индекс и гибридный поиск (`CodeIntelligenceService v2`)** | Вынос `node:sqlite` в `worker_threads`; мультиязычный `web-tree-sitter` (20+ языков + Markdown) со структурным AST-чанкером и шапкой scope; целочисленные ID (`527 МБ → ~65 МБ`); виртуальная таблица **`FTS5` (`bm25` + camelCase/snake_case сплиттер)** + граф символов с **PageRank** + векторы + **`RRF (k=60)`** + пенализация тестов (`×0.35`) + структурная обрезка ответа по чанкам + `chokidar` + автостарт индекса | `kilocode-legacy-main`: `code-index/processors/parser.ts`, `tree-sitter/languageParser.ts`, `continuedev/.../ranking/index.ts` + Aider `RepoMap` PageRank + Continue `FTS5 + RRF` |
| **4** | **SOTA промпты и `Enhance Prompt`** | Стабилизация кэшируемого системного префикса + 4-фазный когнитивный протокол (`Explore → Invariants → Surgical Patch → Verify`); сквозной `PromptEnhancerService` с быстрой инжекцией контекста `CodeIndex` FTS5 / `@mentions` / истории, выбором модели, отменой `AbortController` и безопасным `Undo` в `LexicalChatInput` | `kilocode-legacy-main`: `messageEnhancer.ts`, `support-prompt.ts`, `ChatTextArea.tsx` + промпт-инварианты Codex CLI |
| **5** | **ОС-песочница, агентный PTY, Playwright и Linux/macOS CUA** | `SandboxExecutor` (`bwrap` на Linux + `sandbox-exec` Seatbelt на macOS с `--die-with-parent`); интерактивные PTY-сессии агента поверх `node-pty`; Stateful Browser SDK с авто-сбором `console.error`, `pageerror`, `HTTP >= 400` и ARIA/WebP; нативный Linux CUA (`Electron desktopCapturer / Portal` + `koffi` `libX11`/`libXtst` + `wmctrl`/`xprop`) наряду с macOS Helper | `kilocode-legacy-main`: `BrowserSession.ts`, `Terminal.ts` + OpenAI Codex CLI (`bwrap`/`Seatbelt`/PTY) + OpenHands (замкнутая телеметрия) |
| **6** | **UX композера (`Ghost-Text`) и единые настройки** | Кастомная inline-нода `GhostTextNode` + `ChatAutocompletePlugin` в `LexicalChatInput` (`Tab` — всё, `ArrowRight` — слово, `Escape` — сброс, `removePrefixOverlap`, 3-режимный префиксный кэш, адаптивный дебаунс и сквозной `AbortController`); расширение `AppSettings` и реактивная синхронизация `ISettingService ↔ zcode-cli` | `kilocode-legacy-main`: `ChatTextAreaAutocomplete.ts`, `useChatAutocompleteText.ts`, `AutocompleteInlineCompletionProvider.ts` + Lexical `AutocompleteNode` |
