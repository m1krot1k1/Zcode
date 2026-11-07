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
