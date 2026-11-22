# Workspace facts cache

Статус: implemented (Work 3a), schema version 1.
Дата: 2026-11-20.

## 1. Проблема и цель

`NodeContextSourceAdapter` вычисляет `detectProjectContext` один раз за runtime
(`ensureContextInitialized`). Функция делает поверхностный проход по файлам:
`package.json` scripts, маркеры языков, package manager по lockfile и build-файлы.
Она не классифицирует scripts по назначению, не описывает монорепо, не фиксирует
версии toolchain и не сохраняет provenance.

При этом контекст может резолвиться повторно для нового runtime/session в том же
workspace (desktop host, несколько окон, reconnect, subagent), и каждый раз набор
файлов читается заново.

Цель:

- один персистентный снимок workspace facts на identity ключ, который переиспользуется
  без повторного чтения файлов-источников при неизменных входах;
- детерминированная инвалидация по содержимому входных файлов, git HEAD/dirty и
  runtime-версии Node;
- обогащение: классификация scripts `test/lint/typecheck/build/dev`, устройство
  монорепо, версии toolchain из файлов/окружения, схема verified commands с
  provenance;
- fail-open: любая ошибка кеша не меняет наблюдаемое поведение относительно текущего
  `detectProjectContext`.

Non-goals:

- кеш не выполняет команды (npm/pnpm/git/toolchain) и не создаёт новый execution path;
- кеш не становится символическим/code-индексом и не дублирует CodeIndex;
- кеш не рендерит собственную секцию без enriched facts и не даёт permissions:
  компактная секция `workspace_facts` описывает только обнаруженные факты (см. §8);
- секреты и env-дампы в кеш не попадают.

## 2. Владелец состояния и единственный путь записи

Единственный владелец персистентного состояния — `WorkspaceFactsCache`
(`apps/zcode-cli/packages/adapters/src/context/workspace-facts-cache.ts`).
Единственный вызывающий — `NodeContextSourceAdapter.resolveContextSources`;
`detectProjectContext` больше не читает файлы для обогащённых данных напрямую,
а получает их из cache snapshot.

```text
NodeContextSourceAdapter.resolveContextSources
        │  identityKey + projectRoot + envInfo(git status)
        ▼
WorkspaceFactsCache.resolve ── single-flight по cache file path ──┐
        │                                                          │
        ├─ probe (stat/readdir, без чтения содержимого)            │
        ├─ hit  → ProjectContext из записи (0 чтений фактов)       │
        ├─ hash mismatch → fingerprint (чтение изменённых файлов)  │
        ├─ hit  → обновить stat-отпечатки (та же запись)           │
        └─ miss → compute(snapshot) → atomic tmp+rename ───────────┘
```

- Один путь записи: только `WorkspaceFactsCache.writeEntry`, всегда temp-file +
  `rename` в один и тот же `<cacheRoot>/<digest>.json`.
- Один путь чтения: `WorkspaceFactsCache.loadEntry`.
- Конкурентные вызовы в процессе дедуплицируются по пути cache-файла: первый
  запускает цикл, остальные получают тот же Promise. Кросс-процессно запись
  идемпотентна (одинаковые входы → одинаковый снимок); атомарный rename исключает
  частично записанный JSON, последний писатель побеждает.
- In-memory состояние — только short-lived single-flight map; в нём нет второго
  источника истины: факты в памяти не кешируются между вызовами, источник — файл.

Владелец контракта данных — `packages/contracts/src/interfaces/context-source.port.ts`
(`ProjectContext`, `WorkspaceFacts`). Потребители читают снимок из
`ContextSourceSnapshot.projectContext`; отдельного второго кеша/очереди нет.

## 3. Ключ кеша

Путь cache-файла:

```text
cacheRoot = $HOME/.zcode/v2/cache/workspace-facts   # или explicit cacheRoot опция
file      = cacheRoot/<sha256(identityKey).hex.slice(0,32)>.json
identityKey = workspaceIdentity?.trim() || workspacePath?.trim() || projectRoot
```

- `workspaceIdentity` — единственный ключ身份的 изоляции; для remote workspace он
  уже содержит remote-сегмент (`remote:...`), поэтому отдельный путь для remote не
  нужен: identity даёт другой digest и другую запись.
- Локальный путь (fallback) используется только при отсутствии identity, как в
  AGENTS.md.
- Внутри записи дополнительно хранится `identityKey`; несовпадение с ожидаемым
  трактуется как промах (защита от теоретической коллизии digest).
- Если домашняя директория не резолвится из env адаптера, кеш отключается
  (fail-open, никакой записи в реальный `~` из тестов/сред без HOME).

Компоненты ключа (изменение любого → промах/пересчёт):

| Компонент                          | Источник                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `schemaVersion`                    | версия схемы записи (сейчас `1`)                                                             |
| `identityKey`                      | identity/path по правилу выше                                                                |
| `runtime`                          | `process.version`, `process.platform`, `process.arch`                                        |
| `git.head`                         | чтение `.git/HEAD` + `refs/...` (или `packed-refs`), без запуска git                         |
| `git.dirty` + `git.dirtySignature` | `envInfo.gitStatus`/`gitStatusLines` (уже вычислены адаптером); fallback — stat `.git/index` |
| файлы                              | SHA-256 содержимого + stat-отпечаток (`mtimeMs`,`size`)                                      |

Набор файлов (root-only, детерминированный и ограниченный):

- `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
  `bun.lockb`, `bun.lock`;
- `pnpm-workspace.yaml`, `pnpm-workspace.yml`, `lerna.json`, `turbo.json`, `nx.json`;
- `mise.toml`, `.mise.toml`, `.nvmrc`, `.node-version`;
- `tsconfig*.json` (root), `vitest.config.*`, `jest.config.*`, `playwright.config.*`,
  `cypress.config.*`, `karma.conf.*`, `.mocharc.*`;
- маркеры типа проекта и build-файлы: `requirements.txt`, `pyproject.toml`,
  `setup.py`, `Pipfile`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`,
  `build.gradle.kts`, `Makefile`, `docker-compose.yml`, `docker-compose.yaml`,
  `Dockerfile`.

Для файлов > 16 MiB хеш не читается; используется stat-отпечаток
`oversize:<size>:<mtimeMs>` (задокументированный остаточный риск).

Containment (security):

- входной файл читается только если `lstat` показывает обычный файл (любой symlink,
  включая `.nvmrc`/`.node-version`/`mise.toml`, отвергается как не-file) и
  `realpath` пути лежит внутри `realpath(projectRoot)`;
- `.git`, `gitdir:` и `commondir` читаются только внутри `realpath(projectRoot)`;
  указатель за пределы дерева — fail-closed, без чтения HEAD/refs/packed-refs/index;
- если канонизация невозможна или файл исчез между probe и fingerprint, вход не
  читается, `sha256 = null`; содержимое наружу (в кеш/промпт) не попадает.

Проверка попадания:

1. `schemaVersion` совпадает, запись не старше TTL (24 часа), `identityKey` и
   `runtime` совпадают, git-факты совпадают;
2. набор путей и stat-отпечатки всех входов совпадают → hit без чтения
   файлов-фактов;
3. иначе читаются только файлы с несовпавшими stat; если SHA-256 всех входов
   совпали → hit + обновление stat-отпечатков;
4. иначе miss → полный пересчёт и atomic write.

## 4. Значения

В `ProjectContext` сохраняются прежние поля (`type`, `packageManager`, `scripts`,
`buildFiles`) и добавляется опциональное `workspaceFacts`:

```ts
interface WorkspaceFacts {
  classifiedScripts: Record<
    "test" | "lint" | "typecheck" | "build" | "dev",
    Array<{
      name: string;
      command: string;
      kind: ScriptKind;
      matchedBy: "name" | "command";
    }>
  >;
  monorepo: { isMonorepo: boolean; workspaces?: string[] };
  toolchain: {
    node?: string; // декларация из package.json/.nvmrc/.node-version/mise
    nodeRuntime?: string; // фактический process.version
    packageManager?: string; // packageManager/engines из package.json
    mise?: Record<string, string>;
  };
  verifiedCommands: VerifiedCommand[];
  verifiedCommandsStatus: "unavailable" | "recorded";
  provenance: {
    computedAt: string;
    gitHead?: string;
    gitDirty?: boolean;
    inputs: Array<{ path: string; sha256?: string }>;
  };
}
```

Классификация scripts:

- сначала имя script (токены по `:`, `_`, `-`): `test*`, `lint*`, `typecheck`/
  `type-check`, `build*`, `dev*`/`serve`/`start`;
- затем команда (`vitest`/`jest`/`mocha`/`playwright`/`cypress`/`node --test`,
  `eslint`/`oxlint`/`biome lint`, `tsc --noEmit`/`vue-tsc --noEmit`,
  `tsc -b`/`vite build`/`webpack`/`rollup`/`esbuild`, `vite`/`next dev`/`nodemon`/
  `tsx watch`);
- один script классифицируется не более одного раза, приоритет у совпадения имени;
- неклассифицированные scripts остаются в `scripts`, но не попадают в
  `classifiedScripts`;
- команды перед сохранением редактируются централизованно в `redactCommand`:
  - secret-присваивания по сегменту ключа (`TOKEN`, `SECRET`, `PASSWORD`,
    `AUTH`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIALS`);
  - auth-схемы `Bearer`/`Basic`/`Token` с токеном (≥ 8 символов);
  - bare `Authorization: <token>` без схемы, при этом `Authorization: Bearer` без
    токена не редактируется;
  - query/fragment/assignment-параметры (`[?&#=]`) по секретному сегменту имени,
    без фиксированного whitelist: сегменты `SECRET_KEY_SEGMENT` (`TOKEN`,
    `SECRET`, `PASSWD`, `PASSWORD`, `CREDENTIAL(S)`, `AUTH`, `API_KEY`,
    `ACCESS_KEY`, `PRIVATE_KEY`) плюс `AUTHORIZATION`, `SESSION_ID`, `SIGNATURE`,
    `SIG`. Это покрывает `?client_secret=`, `?refresh_token=`, `?id_token=`,
    `?auth_token=`, `?x-api-key=` независимо от позиции (первый параметр или
    после `&`), а также `#access_token=`; имя сверяется без учёта регистра;
  - имя параметра может быть percent-encoded: `?auth%5Ftoken=`,
    `?client%5Fsecret=`, `?%74oken=`, `?x%2Dapi%2Dkey=`. Имя декодируется через
    `decodeURIComponent` не более трёх проходов: исходное имя и каждый результат
    проверяются на секретный сегмент, поэтому двойное кодирование
    (`?%2574oken=`, `?auth%255Ftoken=`, `?x%252Dapi%252Dkey=`) тоже
    редактируется. Malformed `%` прекращает цепочку декодирования и не роняет
    редактирование, а исходное имя в команде не меняется;
  - вложенный секретный параметр после `?`, `&`, `#` или `=` редактируется
    рекурсивным проходом (не более 3 уровней): `?next=https://h/y?token=...`,
    `?foo=token=...`, `?foo=client_secret=...`; внешнее несекретное значение не
    скрывает вложенный ключ;
  - значение параметра — конкатенация shell-сегментов одного слова, поэтому
    редактируется целиком: quoted + unquoted в любом порядке (`token="abc"def`,
    `token=abc'def'`), escaped-кавычки (`token="abc\"def"`, `token='abc\'def'`),
    escaped newline LF/CRLF (`token="abc\` + newline + `def"`), незакрытая кавычка
    до `&`/`#`/whitespace. Завершающая shell-кавычка URL
    (`'https://h/x?token=abc'`) сохраняется, чтобы не ломать синтаксис исходной
    команды; adjacent quoted-сегмент после unquoted-префикса допускается, только
    если после кавычки сразу идёт содержимое (не пробел), поэтому закрывающая
    shell-кавычка не склеивается со следующим аргументом; percent-encoding
    значения не мешает его границе;
  - известные префиксы токенов даже без secret-ключа: `sk-...`, `ghp_`/`gho_`/
    `ghu_`/`ghs_`/`ghr_`, `glpat-...`, `AKIA...`, `xox[baprs]-...`; префикс
    матчится только на границе идентификатора (negative lookbehind), поэтому
    `app-sk-production` и `task-sk-rebuild-2024` остаются нетронутыми;
  - URL-креды `//user:pass@` и PEM/значения секретов в составе команд.

Toolchain парсится без новых зависимостей: JSON `packageManager`/`engines`,
тримминг `.nvmrc`/`.node-version`, минимальный разбор секции `[tools]` в
`mise.toml` (строковые key/value, лимит 32 записи).

## 5. Provenance и verified commands

Безопасного существующего хука, который фиксирует успешные пользовательские
команды с provenance, в runtime нет (Bash/exec не публикует ledger фактов
workspace). Поэтому Work 3a:

- НЕ добавляет execution path и ничего не запускает;
- оставляет типизированную схему `VerifiedCommand` в кеше;
- всегда пишет `verifiedCommands: []` и `verifiedCommandsStatus: "unavailable"`;
- документирует остаточный риск: проверенные команды появятся только когда
  владелец исполнения (Bash/exec ledger) отдаст событие «команда X успешно
  выполнена, источник Y»; до этого момента кеш не должен угадывать.

## 6. Инвалидация

| Изменение                                                                                                                  | Как обнаружено                                                 | Результат                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| git HEAD                                                                                                                   | сравнение `git.head`                                           | miss/пересчёт                               |
| dirty / dirty signature                                                                                                    | сравнение `envInfo.gitStatus[*]` (fallback: stat `.git/index`) | miss/пересчёт                               |
| dirty signature A→B при неизменных HEAD и stat входов                                                                      | сравнение `git.dirtySignature`                                 | miss/пересчёт                               |
| `package.json`                                                                                                             | stat/SHA-256                                                   | miss/пересчёт                               |
| любой lockfile                                                                                                             | stat/SHA-256                                                   | miss/пересчёт                               |
| `pnpm-workspace.yaml` / `workspaces` / `lerna.json` (включая изменение content без изменения scripts)                      | stat/SHA-256                                                   | miss/пересчёт                               |
| `mise.toml`/`.nvmrc`/`.node-version`                                                                                       | stat/SHA-256                                                   | miss/пересчёт                               |
| `tsconfig*.json`                                                                                                           | stat/SHA-256; новый/удалённый файл меняет набор путей          | miss/пересчёт                               |
| test-конфиги (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `karma.conf.*`, `.mocharc.*`) | stat/SHA-256                                                   | miss/пересчёт                               |
| версия/схема записи                                                                                                        | `schemaVersion`, TTL, `runtime`                                | miss/пересчёт                               |
| повреждённый JSON                                                                                                          | ошибка разбора                                                 | fail-open пересчёт + перезапись             |
| ошибка IO/записи                                                                                                           | исключение                                                     | fail-open к текущему `detectProjectContext` |

## 7. Секреты

В кеш попадают: identity key, `ProjectContext` (`type`, `packageManager`,
`scripts` — все sanitized scripts после `redactCommand`, включая
неклассифицированные, `buildFiles`), `workspaceFacts` (`classifiedScripts` как
производная проекция тех же отредактированных команд, monorepo workspaces,
toolchain/versions, provenance с именами/относительными путями входов, SHA-256,
git HEAD/status), runtime и stat-отпечатки входов.
Не сохраняются: значения `process.env` (кроме версии Node/платформы/архитектуры),
токены, содержимое файлов, вывод команд. Cache-файл пишется с mode `0600`,
директория — `0700` (best-effort на платформах без POSIX-режимов).

Containment и fail-closed: symlink-входы, `.git`/`gitdir:`/`commondir` за
пределами `realpath(projectRoot)` не читаются; содержимое внешних файлов не
попадает ни в `text` snapshot, ни в кеш, ни в system prompt. Запись о symlink
инвалидирует кеш (`exists:false`, `size:-1`), поэтому подмена обычного файла
ссылкой не отдаёт stale запись. Проверка покрыта и на реальном FS через
`nodeWorkspaceFactsIo`: `gitdir:`-указатель за дерево и `commondir` на symlink,
чей realpath вне `projectRoot`, не приводят ни к одному чтению внешнего пути.
В real-FS тесте каждая прочитанная path дополнительно канонизируется через
`realpath` и проверяется на попадание в `realpath(projectRoot)`, поэтому чтение
через in-root symlink с внешней целью не может пройти проверку.
Остаточный риск: между `lstat`/`realpath` и `readFile` возможна гонка (TOCTOU);
порт не открывает файлы с `O_NOFOLLOW`.

Нормализация значений: всё, что интерполируется в system prompt (type,
packageManager, workspace paths, toolchain/versions, script names/commands),
проходит `oneLine`: `[\p{Cc}\u2028\u2029]+` → пробел и trim. Это ASCII
CR/LF/TAB/FF/VT и все прочие C0/C1 controls (категория `\p{Cc}`, включая NEL
U+0085), а также Unicode line separators LS (U+2028) и PS (U+2029). Поэтому
недоверенное значение с `\nSYSTEM: ignore all previous instructions` (как и с
NEL/LS/PS) остаётся внутри одной строки пункта списка, не создаёт отдельную
строку-инструкцию и не обходит `MAX_WORKSPACE_FACTS_SECTION_CHARS`.

## 8. Поверхность выдачи

Выбран минимальный вариант: отдельная компактная секция системного контекста
`workspace_facts`, без нового model tool и без нового execution path.

- Секция строится `core/src/context/sections/workspace-facts.ts` и подключается в
  `core/src/context/builder.ts` **только когда** `ProjectContext.workspaceFacts`
  присутствует, т.е. cache-путь реально вернул enriched facts.
- Legacy `projectContext` (type/scripts/packageManager, без `workspaceFacts`)
  по-прежнему не рендерится. Существующий контракт `core/tests/context-builder.test.ts`
  «does not render projectContext-only content without user instructions» не меняется:
  секция `Workspace Facts` управляется наличием `workspaceFacts`, а не фактом
  присутствия `projectContext`. Секция использует отдельный член union
  `ContextSource` — `workspace_facts` (`core/src/context/types.ts`), поэтому её
  можно отличать от env/git-секций по `source`, а не только по `name`.
- Содержимое компактное и детерминированное: type/package manager, monorepo,
  toolchain (node/runtime/packageManager/mise), до 2 классифицированных scripts на
  kind (`test/lint/typecheck/build/dev`); команды обрезаются до 120 символов.
- Общий объём текста секции ограничен `MAX_WORKSPACE_FACTS_SECTION_CHARS = 1200`:
  worst-case вход (длинные имена/команды, monorepo, mise, toolchain) режется по
  границе строки с маркером `… (truncated)`; заголовок и untrusted-предупреждение
  сохраняются. `section.chars` всегда равен длине итогового `content`.
  Provenance и git head в секции не дублируются — они остаются в типизированном
  поле `workspaceFacts.provenance` и в существующих env/git-секциях.
- Текст секции помечен как untrusted project content: это описательные данные
  репозитория, а не разрешения и не инструкции.
- Формат кеша от способа выдачи не зависит: секция читает уже сохранённый снимок.

## 9. Acceptance-сценарии

1. Первый `resolveContextSources` для workspace делает N чтений файлов-фактов и
   создаёт cache-файл; повторный вызов при неизменных файлах делает 0 чтений
   файлов-фактов (только stat/readdir и чтение git-ref) и возвращает те же facts.
2. Изменение git HEAD инвалидирует запись.
3. Изменение dirty-статуса (signature) инвалидирует запись.
4. Изменение `package.json` (scripts/packageManager) инвалидирует и меняет facts.
5. Изменение lockfile меняет `packageManager` и инвалидирует запись.
6. Изменение `tsconfig*.json` инвалидирует запись (facts могут не измениться).
7. Изменение test-конфига инвалидирует запись.
8. Две разные `workspaceIdentity` (local и remote) для одного пути дают разные
   записи и не переиспользуют facts друг друга.
9. Cache JSON не содержит значения секрета из env; секретоподобные части
   команд редактируются.
10. Конкурентные одновременные resolve выполняют compute и запись один раз
    (single-flight).
11. Повреждённый JSON → пересчёт, перезапись валидной записью, следующий вызов hit.
12. Ошибка IO кеша → возвращается обычный (legacy) результат `detectProjectContext`.
13. Классификация scripts: имя/команда → ожидаемый kind; неклассифицированные не
    попадают в классификацию.
14. Кеш не запускает команды: `verifiedCommands = []`,
    `verifiedCommandsStatus = "unavailable"`; модуль не импортирует
    `node:child_process`.
15. Cache-enriched facts рендерятся одной компактной секцией `workspace_facts`
    (≤ 2 команд на kind, команды обрезаны); `projectContext` без `workspaceFacts`
    секцию не создаёт.
16. Регрессии: смена git HEAD при неизменном stat ref-файла инвалидирует запись;
    `Authorization: Bearer <token>` редактируется до `Bearer <redacted>` без
    редактирования самого заголовка, `Authorization: Bearer` без токена не
    редактируется.
17. Redaction-покрытие: query/fragment/assignment-параметры с секретным
    сегментом имени (`?token=`, `?api_key=`, `?secret=`, `?client_secret=`,
    `?auth_token=`, `?x-api-key=`, `#access_token=`, uppercase) редактируются до
    `<redacted>`, включая quoted, escaped-quote, escaped-newline и mixed
    (quoted + unquoted) значения; percent-encoded имена (`?auth%5Ftoken=`,
    `?client%5Fsecret=`, `?%74oken=`, `?x%2Dapi%2Dkey=`) и двойное кодирование
    (`?%2574oken=`, `?auth%255Ftoken=`, `?x%252Dapi%252Dkey=`) декодируются
    ограниченно (<= 3 проходов) перед проверкой; вложенные параметры
    (`?next=https://h/y?token=...`, `?foo=token=...`,
    `?foo=client_secret=...`) тоже покрыты; bare `Authorization: <token>`
    (включая `ghp_...`) редактируется без схемы; префиксные токены (`sk-`,
    `ghp_`, `glpat-`, `AKIA`, `xox[baprs]-`) редактируются без secret-ключа, но
    не внутри обычных идентификаторов (`app-sk-production`).
18. Containment: symlink `.nvmrc`/`.node-version`/`mise.toml` (в том числе на файл
    вне проекта) не читается и не рендерится; `.git`-symlink, `gitdir:` и
    `commondir` за пределами `projectRoot` не читаются (fail-closed); внешние
    пути не появляются в `WorkspaceFactsIo.readFile`. Сценарий проверяется и на
    реальном FS через `nodeWorkspaceFactsIo` (`gitdir:`-файл за дерево и
    `commondir` на symlink с realpath вне `projectRoot`); realpath каждой
    прочитанной path сверяется с `realpath(projectRoot)`, поэтому in-root symlink
    с внешней целью не проходит проверку.
19. Total prompt bound: worst-case fixture с максимальными по длине полями даёт
    `section.chars <= MAX_WORKSPACE_FACTS_SECTION_CHARS` (1200) без потери
    заголовка/untrusted-предупреждения; per-kind лимиты и «projectContext-only не
    рендерится» остаются в силе.
20. Invalidation matrix: изменения `jest.config.*` и `playwright.config.*`
    инвалидируют запись так же, как `vitest.config.*`; смена `dirtySignature`
    A→B при неизменных HEAD/stat и изменение `pnpm-workspace.yaml` без изменения
    scripts инвалидируют запись.
21. Redaction-покрытие (security recheck): секретные query/fragment/assignment-
    параметры определяются по сегменту имени (`?client_secret=`,
    `?refresh_token=`, `?id_token=`, `?auth_token=`, `?x-api-key=`,
    `#access_token=`, uppercase); quoted, escaped-quote, escaped-newline и mixed
    (quoted + unquoted, в любом порядке) значения редактируются целиком, без
    хвоста после закрывающей кавычки; percent-encoded имена (`?auth%5Ftoken=`,
    `?client%5Fsecret=`, `?%74oken=`, `?x%2Dapi%2Dkey=`) и двойное кодирование
    (`?%2574oken=`, `?auth%255Ftoken=`) декодируются перед проверкой не более
    трёх проходов; вложенные после `?`/`&`/`#`/`=` секретные параметры
    редактируются (не более 3 уровней рекурсии); provider-подобные подстроки в
    обычных идентификаторах (`app-sk-production`) — нет.
22. Prompt-safety: ASCII CR/LF/TAB/FF/VT, прочие C0/C1 controls и Unicode line
    separators NEL/LS/PS в любом интерполируемом значении нормализуются в
    пробел; вход с `SYSTEM: ignore all previous instructions` после любого из
    этих разделителей не создаёт отдельную строку в `section.content` и не
    превышает общий cap.

### Остаточные риски redaction

Границы, не ослабляющие гарантии выше:

- глубина percent-декодирования имени ограничена тремя проходами: имена,
  закодированные четырьмя и более слоями `%25` (например,
  `?%25252574oken=`), не распознаются;
- percent-encoded разделители внутри значения (`%26`, `%23`, `%3D`, `%3F`) не
  декодируются перед поиском вложенного параметра, поэтому секрет после
  encoded `?`/`=`/`&` в несекретном внешнем значении не обнаруживается;
- незакрытая кавычка значения потребляется только до `&`/`#`/whitespace; хвост
  за пробелом считается отдельным shell-словом и не входит в redaction;
- malformed `%` прекращает цепочку декодирования имени: слои за точкой ошибки
  не проверяются.

## 10. Метрика (методология)

Измеряется не wall-clock (реальный выигрыш зависит от диска, антивируса, кеша ОС и
не воспроизводим в unit-тесте), а число чтений файлов-источников фактов:

- инструментированный `WorkspaceFactsIo.readFile` считает вызовы по путям
  `package.json`, lockfile, `tsconfig*`, test-конфиги;
- первый вызов (miss) — `firstReads`; второй вызов с теми же файлами (hit) —
  `secondReads`; ожидается `firstReads > 0`, `secondReads === 0`;
- stat/readdir и чтение `.git/HEAD` не входят в счётчик, но перечисляются как
  остаточная стоимость hit-path.

Ограничения: тест доказывает, что hit не перечитывает файлы-факты, но не измеряет
latency и не покрывает кросс-процессный кеш ОС; отдельный benchmark не выполнялся.
