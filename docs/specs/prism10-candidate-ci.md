# Безопасная CI-проверка кандидата PRISM

## Цель и границы доказательства

Проверки выполняются только локально на Mac перед commit/push. Push не запускает GitHub Actions, не расходует GitHub runner minutes и не зависит от billing аккаунта. Локальный gate — `pnpm verify:pre-push` (lint, schema, architecture, affected unit tests и self-improve workflow tests); перед сборкой релиза дополнительно выполняются typecheck и релизные сборочные проверки. Commit SHA и фактические результаты сохраняются в локальном выводе/артефактах команды. Никакой локальный PASS не представляется как результат GitHub-hosted CI.

Обычные push и pull request не запускают GitHub Actions: локальные проверки остаются обязательным CI и не расходуют hosted runner minutes. По прямому решению владельца добавлен только `.github/workflows/cross-platform-preview-release.yml`, запускающий сборку по версионному tag для публикации Preview релиза на macOS, Windows и Linux. Workflow не запускается от PR или push в ветку. `pull_request_target` нельзя использовать для checkout, install, build, test или другого исполнения PR-кода. PRISM `--apply` остаётся закрытым независимо от локального CI.

Успешная CI проверка доказывает только прохождение перечисленных команд на данном commit и runner image. Она не доказывает качество модели, корректность acceptance oracle, улучшение исхода, безопасность merge, независимую валидацию PRISM receipts, production release или rollback. Эти действия остаются отдельными защищёнными решениями.

## Контракт локального CI

- Trigger: локальный запуск человеком или локальным release-скриптом; git push сам по себе ничего не запускает.
- Toolchain: версии из `mise.toml`; зависимости устанавливаются frozen lockfile.
- Gates перед push: `pnpm verify:pre-push`; дополнительные проверки сборки/релиза описаны в релизной инструкции.
- Preview release script обязан после проверки чистой `dev` и синхронности с `origin/dev`, но до изменения версии, сборки, commit или push выполнить локально `pnpm verify:pre-push` и `pnpm typecheck`. Ошибка любого gate прерывает выпуск, не меняя версию и не создавая артефакты/commit/tag. Lint входит в `verify:pre-push` и не должен запускаться второй раз без отдельной причины.
- Любой локальный вызов electron-builder явно передаёт `--publish never`: наличие `CI=true` не должно включать неявную публикацию артефактов из локальной сборки.
- Evidence: локальные exit codes, commit SHA и артефакты сборки. Не утверждать hosted-runner status или удалённый CI pass.
- Никакие GitHub credentials или Actions tokens не используются проверками.
- Запрещено автоматически трактовать green check как разрешение на merge, promotion, release либо запуск evaluator на непроверенном artifact.

## Приёмка

| ID    | Сценарий                                    | Проверяемый результат                                                                                                                                                   |
| ----- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-01 | `pnpm verify:pre-push` завершился успешно   | Локальный gate завершает все перечисленные шаги с exit code 0 на текущем SHA.                                                                                           |
| CI-02 | Любой локальный gate завершился ошибкой     | Push/release не объявляется проверенным; зафиксированы реальная ошибка и место остановки.                                                                               |
| CI-03 | `git push` в `dev`                          | В `.github/workflows` нет активного workflow, запускаемого push, и пользовательские Actions runner минуты не расходуются.                                               |
| CI-04 | Локальная проверка и release                | В отчёте явно указано, что это локальные доказательства, а не hosted GitHub Actions run.                                                                                |
| CI-05 | Локальная упаковка desktop                  | Аргументы electron-builder содержат `--publish never`, в том числе при `CI=true`; запуск не передаёт артефакты удалённому provider.                                     |
| CI-06 | Preview release запускается на чистой `dev` | `verify:pre-push` и `typecheck` завершились успешно до изменения версии или запуска сборки; при ошибке release checkout остаётся неизменным и публикация не начинается. |
