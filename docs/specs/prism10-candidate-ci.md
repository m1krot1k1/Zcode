# Безопасная CI-проверка кандидата PRISM

## Цель и границы доказательства

Pull request в `dev` получает воспроизводимую проверку точного head commit кандидата: frozen dependency install, typecheck, lint, affected unit tests, architecture checks и self-improve workflow tests. GitHub Actions сохраняет результат вместе с commit SHA.

У workflow минимальные read-only permissions. Он не получает repository secrets, не использует signing/notarization credentials, не создаёт ветки/PR, не сливает и не публикует код. Кандидат из PR считается недоверенным: checkout точного head SHA запускается только на изолированном GitHub-hosted runner с `persist-credentials: false`. Конкурирующие проверки одного PR могут отменяться; публикационные workflow из них не запускаются.

Успешная CI проверка доказывает только прохождение перечисленных команд на данном commit и runner image. Она не доказывает качество модели, корректность acceptance oracle, улучшение исхода, безопасность merge, независимую валидацию PRISM receipts, production release или rollback. Эти действия остаются отдельными защищёнными решениями.

## Контракт workflow

- Trigger: `pull_request_target` в `dev` для `opened`, `synchronize`, `reopened`, `ready_for_review`, `edited` (включая изменение base branch), чтобы правила workflow брались из доверенной base-ветки при изменении кандидатом workflow-файлов. Код кандидата выполняется только на GitHub-hosted runner, с read-only token, без secrets и без сохранения checkout credentials.
- Checkout: `github.event.pull_request.head.sha`; workflow сообщает его в run summary и artifact manifest.
- Permissions: только `contents: read`; ни workflow, ни дочерние шаги не используют write token или secrets.
- Runner и toolchain: `ubuntu-24.04`; Node и pnpm устанавливаются по `mise.toml`; dependency install использует `pnpm install --frozen-lockfile`. GitHub Actions фиксируются на проверенных полных commit SHA.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check -- --changed --base <PR base SHA>`, `pnpm test:unit:affected --base <PR base SHA>` и `pnpm test:self-improve-pr`.
- Result bundle: текстовый manifest с commit SHA, workflow run identity и командами/exit codes; загрузка выполняется и при провале gate. До checkout/setup создаётся начальный manifest, чтобы setup failure тоже оставил доказательство запуска. Никаких credential values, пользовательских данных или рабочих tree artifacts.
- Запрещено автоматически трактовать green check как разрешение на merge, promotion, release либо запуск evaluator на непроверенном artifact.

## Приёмка

| ID    | Сценарий                                             | Проверяемый результат                                                                                                                                      |
| ----- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-01 | PR обновлён новым head                               | Проверяется checkout exact `pull_request.head.sha`; summary и manifest содержат тот же SHA.                                                                |
| CI-02 | Недоверенный PR код                                  | Job имеет только `contents: read`, не раскрывает secrets, checkout не сохраняет token в `.git/config`; workflow не имеет write/deploy permissions.         |
| CI-03 | Любой gate падает                                    | Run красный, итоговый manifest/log artifact всё равно загружается и указывает упавшую команду.                                                             |
| CI-04 | Все gates проходят                                   | Run зелёный только после install/typecheck/lint/architecture/affected tests/self-improve tests; output явно ограничивает claim прохождением этих проверок. |
| CI-05 | PR в другую ветку или release event                  | Этот workflow не запускается; он не меняет теги, Releases, ветки, PR и deployment feeds.                                                                   |
| CI-06 | Checkout или установка toolchain завершается ошибкой | Начальный manifest загружается; он не помечает непроизведённые проверки как пройденные.                                                                    |
| CI-07 | Открытый PR перенаправлен в `dev`                    | Событие `edited` запускает workflow для новой base-ветки `dev`.                                                                                            |
