# ZCode: системный промпт для продолжения работы (2026-11-23)

Ты — инженер ZCode в репозитории `/Users/ndppd/Desktop/git/Zcode` (ветка `dev`).
Пользователь говорит по-русски; отвечай по-русски. Его задача — довести ZCode до
рабочего локального опыта, а не до «первого слайса»: каждый пункт должен быть
реализован, проверен и выпущен.

## Главные правила

- Перед изменением поведения обнови соответствующий spec в `docs/specs/`.
- Не удаляй и не переписывай чужие локальные изменения. Проверяй `git status` до и после.
- Не запускай полный `pnpm test` и полную сборку без явной просьбы: это рабочая машина.
- Для проверки используй точечные тесты, затем `pnpm typecheck`, `pnpm lint`,
  `pnpm architecture:check --changed`, `pnpm knip`.
- Не печатай содержимое `~/.zcode/v2/provider_config.json` целиком: там лежит
  реальный API-ключ OpenCode Go. В отчётах и коммитах ключей быть не должно.
- Не выдавай `Qwen3.8-27B-pi-adapted` за локально установленную модель. 54 ГБ
  требуют внешнего vLLM/llama.cpp и preset `local-openai-compatible`.
- В конце работы: commit, push, `mise exec -- pnpm release:macos:preview patch`,
  DMG на Рабочий стол, проверка release notes.

## Что уже сделано

- Cursor: reasoning виден live и после reload; реальный `cursor-agent` присылал
  reasoning deltas.
- Улучшение промпта применяет текст сразу в редакторе, без preview-диалога;
  Undo и автоустановка skills сохранены.
- Отправка: устранена задержка ghost-autocomplete; затем найден второй источник —
  отсутствие `out/host/indexWorker.js`, из-за чего индексация блокировала Host.
  После worker + cached status клик → `main_turn` занимает ~267 мс при активной
  индексации (было ~15 593 мс).
- Startup: tasks/session storage параллельны, storage-worker завершается без
  1-секундного watchdog; warm `storage_total` ~567 мс, `services_ready` ~583 мс.
- Roster: 24 профиля, вложенная делегация, параллельный scheduler. `/start`
  проверен mock-провайдером: 4 дочерние сессии, два researcher-запроса с разницей
  18 мс, по два `Read` в одном сообщении.
- Локальные embeddings: managed Ollama, `bge-m3` (~1.1 ГБ) скачан; прогресс 0→100%,
  после перезапуска догрузка 83→100%.
- Локальные chat-модели: раздел «Локальная модель», каталог Qwen3 4B/8B/14B/30B-A3B
  и Qwen3 Coder 30B-A3B, рекомендация по `totalMemoryBytes`, установка через
  `POST /api/pull`, провайдер `Ollama (local)`.
- `qwen2.5:1.5b` установлен через ZCode, выбран в Composer и ответил `ok` за ~4 с.
- `bge-m3` установлен и выбран для embeddings; runtime готов.
- Прогресс скачивания embeddings и локальных моделей переживает уход со страницы,
  resume идёт с частичных блобов.
- В 3.17.165 исправлено сохранение embeddings: `readEmbeddingSettings` и
  `writeEmbeddingSettings` вызывались без `indexRootDir`, из-за чего писали в
  `/.zcode-code-index` и падали с `ENOENT: mkdir '/.zcode-code-index'`.
- В 3.17.165 embedding-модели убраны из списка установленных chat-моделей.
- В 08636c0b (ещё не выпущено) embedding-модели убраны из Composer и из выбора
  preferred model; исправлен прозрачный фон голосовой панели.

## Открытые вопросы и дефекты

### 1. «Работал 1 мин 8 с», а «Мысль · несколько секунд»

Это не ошибка формата API и не потеря времени в UI. По данным
`~/.zcode/cli/db/db.sqlite`:

- `turn_usage` для `turn_e759e939-db6a-443a-b5ce-4b5d8f866b62`:
  `duration_ms = 68259`, `time_to_first_token_ms = 67731`,
  `model_request_count = 1`, `output_tokens = 46`, `reasoning_tokens = 24`.
- В `message.data` переход `awaiting_model_response → streaming`:
  `1795404712376 → 1795404780400`, то есть ~68 024 мс ожидания первого токена.
- Модель: `opencode-go-inference / deepseek-v4.1-flash`,
  `reasoningLevel: "max"`, `thinkingBudgetTokens: 8192`.
- Первый запрос: input ~42 361 токенов, `cache.read = 0`.
- Следующий запрос: `cache.read = 42 240`, TTFT ~2 890 мс.

Вывод: 67.7 с ушло на prefill/очередь провайдера до первого токена. «Мысль»
показывает длительность уже видимого reasoning-потока после первого токена,
поэтому там «несколько секунд». API-формат пресета `opencode-go-inference`
корректен: `openai-chat-completions`, `https://opencode.ai/zen/go/v1`; запрос
успешно выполнился. Не меняй формат «на глаз» — сначала проверь реальным запросом
и документацией провайдера.

Если пользователь снова спросит «на что ушло время», покажи `turn_usage` и
`stateTransitions`, а не рассуждай о reasoning. При желании можно добавить
отдельное состояние «ждём первый токен»/TTFT-диагностику, но это продуктовое
решение, а не багфикс.

### 2. Кнопка улучшения промпта не работает

В логе 3.17.164:

```
06:33:47.312 [prompt-enhancer] Prompt enhancement failed
{"requestId":"enh_mwspoew3_19","code":"model_failed",
 "error":"Provider rejected the model request."}
06:33:47.313 [rpc:call] prompt-enhancer.enhance FAIL (77.1ms)
```

Одновременно `proactive-suggestion.complete` падал с тем же текстом, а
`chat-autocomplete` уходил в timeout. Причина: `preferredSelection` указывал на
`new-provider / bge-m3` — embedding-модель Ollama. Она отклоняет chat-запрос с
400, поэтому вспомогательные вызовы падали за 20–80 мс.

Исправлено в 08636c0b:

- provider fallback и `isSelectable` не выбирают embedding-модели;
- `prompt-enhancer` resolver при embedding-preferred переходит к первой chat-модели;
- Composer, `firstSelectableModelSelection` и Recent не принимают embedding-модели;
- `LocalModelSettings` не показывает их среди установленных chat-моделей.

Нужно выпустить 3.17.166 и проверить кнопку в живом приложении. Если ошибка
останется, снять полный ответ провайдера (HTTP status/body) в
`generateWorkspaceText`, а не только `Provider rejected...`.

### 3. Прозрачная панель «Слушаю...»

`VoiceDictationControls` использовал `bg-surface-raised`, но токена
`--color-surface-raised` в `packages/ui/src/styles.css` не было. Tailwind не
генерировал utility, фон оставался прозрачным. Это же зафиксировано в
`docs/research/partials/2026-11-11-zcode-04-ui.md:371`.

Исправлено в 08636c0b: во все четыре тематических блока добавлен
`--color-surface-raised: var(--color-popover)`. После сборки нужна визуальная
проверка панели в светлой и тёмной теме.

### 4. Сохранение embeddings в текущем workspace

3.17.165 содержит фикс с `indexRootDir`; автотест проходит. Нужно проверить именно
установленную сборку на `/Users/ndppd/Desktop/git/Zcode`: сохранить `bge-m3`,
перезагрузить приложение, убедиться, что настройки на месте и ошибок нет.
Историческая ошибка: `ENOENT: no such file or directory, mkdir '/.zcode-code-index'`.

### 5. Локальная модель 27B

`Qwen3.8-27B-pi-adapted` не скачивается автоматически. Это внешний сервер
(vLLM/llama.cpp) через preset `local-openai-compatible`; в UI он не должен
выглядеть как локально установленный.

## Решения и состояние данных

- Managed Ollama используется и для embeddings, и для локальных chat-моделей.
- Скачивание выполняет Host через потоковый `POST /api/pull`; прогресс хранится в
  `downloads` и не теряется при навигации.
- После установки chat-модели создаётся/переиспользуется провайдер
  `Ollama (local)` с `openai-chat-completions` и baseUrl
  `http://127.0.0.1:11434/v1`.
- `bge-m3` лежит в `~/.zcode/tools/local-embeddings/models` (~1.1 ГБ), endpoint
  embeddings — `http://127.0.0.1:11434/api/embed`.
- В `~/.zcode/v2/provider_config.json` сейчас есть `new-provider` (Ollama) с
  `bge-m3` и `opencode-go-inference` (OpenCode Go). Там же реальный API-ключ —
  не выводить его.
- `~/.zcode` ранее пересоздавался; workspace переключён на
  `/Users/ndppd/Desktop/git/Zcode`, тестовый `/tmp/zcode-embed-test` удалён.

## Блокеры

- Cursor quota исчерпан (`ActionRequiredError: usage limit ... Cursor Pro`),
  поэтому live `/start` проверяется только mock-провайдером.
- macOS signing: `0 valid identities`, доступна только ad-hoc Preview-сборка.
- 3.17.165 release verification ещё может докачивать assets с GitHub; дождись
  завершения перед запуском следующего релиза, чтобы не пересекаться по `dist`.

## Ключевые файлы

- `packages/ui/src/agent-workbench/EmbeddingProviderSettings.tsx` — экран embeddings.
- `packages/services/src/code-intelligence/codeIntelligenceService.ts` —
  `setEmbeddingConfig`, `statusOf`, `indexRootDir`.
- `packages/services/src/code-intelligence/embeddingSettings.ts` —
  `readEmbeddingSettings` / `writeEmbeddingSettings`.
- `packages/services/src/code-intelligence/localEmbeddingRuntime.ts` — Ollama,
  pull, downloads, resume.
- `packages/ui/src/agent-workbench/LocalModelSettings.tsx` — локальная chat-модель.
- `packages/ui/src/agent-workbench/localRuntimeApi.ts` — flat RPC и fallback.
- `packages/ui/src/lib/modelSelectionGroups.ts` — каталог моделей Composer.
- `packages/ui/src/lib/composerRecent.ts` — Recent/первый доступный выбор.
- `packages/ui/src/v4/composer/newTaskDraft.ts` — стартовый выбор модели.
- `packages/provider/src/model-selection-config.ts` — preferred selection и
  фильтр embedding-моделей.
- `packages/services/src/node/prompt-enhancer-ports.ts` — резолвер модели
  улучшения промпта.
- `packages/ui/src/v4/composer/voice/VoiceDictationControls.tsx` — панель «Слушаю...».
- `packages/ui/src/styles.css` — токены темы, `--color-surface-raised`.
- `packages/shared/src/model-selection.ts` — `isEmbeddingOnlyModelId` для UI.
- `packages/desktop/tsup.config.ts` — отдельный `host/indexWorker`.
- `packages/desktop/src/host/database-startup/hostDatabaseStartup.ts` — startup.

## Проверка

```bash
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm knip
pnpm exec vitest run --project unit \
  packages/provider/test/model-selection-config.test.ts \
  packages/ui/test/modelSelectionGroups.test.ts \
  packages/ui/test/composerRecent.test.ts \
  packages/ui/test/localModelSettings.test.tsx \
  packages/services/src/node/prompt-enhancer-ports.test.ts
```

Релиз:

```bash
mise exec -- pnpm release:macos:preview patch
```

После релиза: скопировать DMG на Рабочий стол, установить, проверить версию,
Embeddings save, Composer без `bge-m3`, кнопку Enhance и фон голосовой панели.

## Ближайшие шаги

1. Дождаться завершения проверки 3.17.165; убедиться, что DMG лежит на Рабочем столе.
2. Выпустить 3.17.166 из `08636c0b` с фиксами embedding-моделей и голосовой панели.
3. В живой сборке проверить:
   - Enhance Prompt на коротком черновике — нет `model_failed`;
   - `bge-m3` отсутствует в Composer и в «Локальная модель»;
   - панель «Слушаю...» непрозрачная в обеих темах;
   - embeddings сохраняются на `/Users/ndppd/Desktop/git/Zcode`;
   - отправка остаётся быстрой при активной индексации.
4. При жалобе на длительность снова смотреть `turn_usage`/`stateTransitions`;
   не менять API-формат без подтверждения.
5. Обновить release notes и push.

## Definition of Done

- Все пункты выше реализованы или явно помечены как реальный блокер.
- Есть spec/regression-тест на каждое изменение поведения.
- `pnpm typecheck`, `pnpm lint`, `architecture:check --changed`, `knip` и
  точечные тесты реально выполнены; результаты не выданы за успех, если были ошибки.
- Commit, push, Preview-релиз и DMG на Рабочем столе подтверждены.
