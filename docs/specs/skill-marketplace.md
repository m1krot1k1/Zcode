# Skill Marketplace (skills.sh)

## Цель

Дать агенту нативный доступ к публичному каталогу skills.sh: искать скиллы,
устанавливать их в workspace и сразу загружать через существующий `Skill` tool.
Никакого `npx skills` в runtime и никакого исполнения кода из снапшота.

## Источник и API

Публичные endpoints, которые использует официальный `skills` CLI и которые не
требуют Vercel OIDC:

- `GET https://skills.sh/api/search?q=<query>[&owner=<owner>]`
  → `{ skills: [{ source, skillId, name, installs }] }`
- `GET https://skills.sh/api/download/<owner>/<repo>/<skillId>`
  → `{ files: [{ path, contents }], hash }`

`/api/v1/*` требует Vercel OIDC и в runtime не используется.

## Поток

1. `SkillSearch` вызывает `SkillPort.searchMarketplace`, получает результаты,
   сортирует по `installs` и помечает уже установленные скиллы.
2. `SkillInstall` вызывает `SkillPort.installMarketplaceSkill`:
   - скачивает снапшот;
   - валидирует каждый относительный путь, размеры и наличие корневого `SKILL.md`;
   - пишет файлы в `<workspace>/.agents/skills/<skillId>` (scope `workspace`)
     или `~/.agents/skills/<skillId>` (scope `user`);
   - пишет `_meta.json` с source/skillId/hash/installedAt;
   - вызывает `discoverSkills`, чтобы вернуть фактическое имя скилла.
3. Агент вызывает `Skill { skill: "<name>" }` — `NodeSkillAdapter.loadSkill`
   каждый раз заново сканирует roots, поэтому установленный скилл доступен
   в том же turn без перезапуска.

## Безопасность

- Снапшот — недоверенный ввод. Разрешены только относительные пути без `..`,
  `\`, NUL и абсолютных путей.
- Лимиты: 500 файлов, 10 MiB суммарно, 5 MiB на файл.
- Обязателен `SKILL.md` в корне; имя/description валидирует существующий парсер.
- Содержимое не исполняется: скрипты из скилла не запускаются автоматически.
- Существующий hand-written скилл с тем же slug не перезаписывается даже при
  `overwrite: true`; перезапись разрешена только для каталога с `_meta.json`
  от marketplace и совпадающим source.
- Сеть: только `https://skills.sh`, таймауты и retry на 429/5xx.

## Инструменты и роли

- `SkillSearch` — read-only, deferred, доступен inspection и worker-ролям.
- `SkillInstall` — workspace write, deferred, доступен worker-ролям.
- `start`/`orchestrator` остаются Task-only и marketplace-инструментов не получают.
- `reviewer`/`security-reviewer` остаются read-only и не устанавливают скиллы.

## Синхронизация топ-скиллов в репозиторий

`pnpm skills:sync` (`scripts/sync-skills-sh.mjs`) скачивает выбранные скиллы в
`.agents/skills` и обновляет `skills-sh.lock.json`.

Поддерживаются:

- `--limit`, `--min-installs`, `--queries`, `--exclude`, `--dest`, `--dry-run`;
- `--skills owner/repo/skill,...` для курированного списка без поиска.

Скрипт пропускает скиллы, чьё имя уже есть в `.agents/skills` или в bundled
skills, и не перезаписывает существующие каталоги. Lock-файл хранит source,
skillId, installs и hash для воспроизводимости.

## Проверки

- `apps/zcode-cli/packages/adapters/tests/skill-marketplace.test.ts`:
  поиск/сортировка/installed, установка и немедленная загрузка, path traversal,
  отсутствие `SKILL.md`, запрет перезаписи hand-written скилла.
- `apps/zcode-cli/packages/core/tests/skill-marketplace-tool.test.ts`:
  форматирование результатов, сообщение об установке, fail-closed без порта.
- `subagent-profile`/`runtime-tool-allowlist`/`tool-contracts`:
  marketplace-инструменты не попадают к роутерам и review-ролям.

## Сервисный слой (Desktop, `@zcode/services`)

UI Marketplace ходит в `ISkillsService` (канал `skills`, `packages/shared/src/channels.ts`)
и не вызывает skills.sh напрямую. Владелец состояния — `createSkillsService` в
`packages/services/src/skills/skillsService.ts`; сеть и запись инкапсулированы в
`packages/services/src/skills/skillMarketplace.ts`.

### Контракт (`packages/shared/src/skills-types.ts`)

- `type SkillInstallScope = "workspace" | "user"`.
- `interface MarketplaceSkillInfo { name; source; installs; installed }`.
- `interface InstallMarketplaceSkillRequest { name; scope; }` — плюс совместимые
  необязательные `workspacePath`/`workspaceIdentity`: у Host нет единственного
  активного workspace, поэтому для `scope: "workspace"` путь передаёт вызывающая сторона.
- `interface InstallMarketplaceSkillResult { name; scope; path }`, где `name` — имя
  из frontmatter `SKILL.md` (fallback — имя каталога).
- `searchMarketplace(query: string, context?: { workspacePath?; workspaceIdentity? }):
  Promise<MarketplaceSkillInfo[]>`; пустой/пробельный query → `[]` без сети.
- `installMarketplaceSkill(request): Promise<InstallMarketplaceSkillResult>`.

### Поиск

- `GET https://skills.sh/api/search?q=<query>`; таймаут 15 с; не-200 → `http_error`,
  сеть/таймаут → `network`, невалидный JSON → `invalid_response`.
- `installed` вычисляется по существующим корням `.zcode/skills`/`.agents/skills`:
  workspace-корни только при переданном `context.workspacePath`, user-корни — когда
  runtime desktop-capable. Запись и кеш отсутствуют.

### Установка

- `name` — `owner/repo/skillId` или голое имя (разрешается через search, берётся
  наиболее устанавливаемый точный матч). `GET https://skills.sh/api/download/<owner>/<repo>/<skillId>`,
  таймаут 20 с; не-200 → `http_error`, сеть → `network`.
- Payload: `{ files: [{ path, contents }], hash? }`; толерантно принимается
  `content` вместо `contents` и `files` как объект `{ path: content }`.
- Валидация до записи: только относительные пути; `\` нормализуется в `/`;
  запрещены абсолютные пути, drive-letter, NUL, `..`, пустые/дублирующиеся пути.
  Обязателен `SKILL.md` в корне. Лимиты: ≤ 500 файлов, ≤ 5 MiB на файл,
  ≤ 10 MiB суммарно (`limit_exceeded`), нарушение путей → `unsafe_snapshot`.
- Порядок событий: resolve → download → validate/limits → `mkdtemp` внутри
  целевого skills-корня → запись файлов → `_meta.json` → `rename` в
  `<корень>/<sanitized-skillId>`. При ошибке temp удаляется; частичного каталога
  не остаётся. Запись не выходит за пределы skills-корня.
- Каталоги: `<workspacePath>/.agents/skills/<name>` (`workspace`) и
  `os.homedir()/.agents/skills/<name>` (`user`).
- Существующий каталог заменяется только если `_meta.json` указывает на тот же
  `source`/`skillId`; hand-written скилл → `write_conflict` и не изменяется.
  Повторная установка идемпотентна: каталог заменяется целиком, обновляются
  `hash`/`installedAt`. Конкурентные установки и `setEnabled` сериализуются общим
  `writeQueue` сервиса.
- `_meta.json`: `source`, `skillId`, `name`, `scope`, `hash`
  (`sha256` по отсортированным относительным путям + байтам), `remoteHash`,
  `installedAt`, `version` из frontmatter при наличии, `manager: "skills.sh"`.
- Скачанный контент не исполняется и не логируется; логируются только имя,
  source, skillId, scope и код ошибки.

### RPC

`ProxyChannel` автоматически публикует методы интерфейса: регистрация сервиса —
`packages/services/src/node.ts` (`.register(ISkillsService, skillsService)`),
диспетчеризация по имени метода — `packages/rpc/src/proxy-channel.ts`.
Отдельный allowlist не нужен; новый Remote Host не создаётся.

### Приёмочные сценарии

- search: happy (маппинг + installed), пустой результат, пустой query без сети,
  не-200, сетевая ошибка, невалидный JSON.
- install: happy (файлы + `_meta.json` + фактическое имя), `files`-объект,
  голое имя через search, user scope, повторная установка, не-200 без записи.
- Отказы: path traversal, абсолютный/drive-letter путь, > 500 файлов,
  > 5 MiB файл, > 10 MiB суммарно, отсутствие корневого `SKILL.md`,
  перезапись hand-written скилла, workspace scope без `workspacePath`.

Проверки: `packages/services/test/skillMarketplace.test.ts`
(`pnpm vitest run packages/services/test/skillMarketplace.test.ts`).
