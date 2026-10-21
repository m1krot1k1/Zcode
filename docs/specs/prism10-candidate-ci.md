# Безопасная CI-проверка кандидата PRISM

## Цель и границы доказательства

Прямой push в `dev` получает воспроизводимую проверку точного commit: frozen dependency install, typecheck, lint, affected unit tests, architecture checks и self-improve workflow tests. GitHub Actions сохраняет результат вместе с commit SHA; для push базой сравнения служит SHA из события `before`.

У workflow минимальные read-only permissions; он не ссылается на repository secrets, не использует signing/notarization credentials, не создаёт ветки/PR, не сливает и не публикует код. Workflow запускается только для прямого push в `dev`, где исполняемый workflow является частью коммита доверенного участника. PR trigger намеренно отсутствует: `pull_request` исполняет workflow из PR merge commit, а fork ограничения на secrets не применяются к same-repository PR, поэтому кандидат может изменить policy. `pull_request_target` нельзя использовать для checkout, install, build, test или другого исполнения PR-кода. [GitHub описывает elevated trust `pull_request_target` и риск checkout/исполнения PR-кода](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target); [документация событий отдельно ограничивает secrets для fork PR](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories). Для проверки недоверенных PR нужен отдельный trusted workflow на фиксированной ревизии с изолированным secret-free runner; пока он не установлен, этот workflow не является PR gate, а PRISM `--apply` остаётся заблокированным.

Успешная CI проверка доказывает только прохождение перечисленных команд на данном commit и runner image. Она не доказывает качество модели, корректность acceptance oracle, улучшение исхода, безопасность merge, независимую валидацию PRISM receipts, production release или rollback. Эти действия остаются отдельными защищёнными решениями.

## Контракт workflow

- Trigger: только `push` в `dev`. PR trigger отсутствует, поскольку workflow policy из самого same-repository PR может раскрыть доступные этому run secrets. `pull_request_target` нельзя использовать для исполнения кода PR.
- Checkout: точный `github.sha`; базой affected/architecture checks служит `github.event.before`. Workflow сообщает обе ревизии в summary и artifact manifest.
- Permissions: только `contents: read`; ни workflow, ни дочерние шаги не используют write token или secrets.
- Runner и toolchain: `ubuntu-24.04`; Node и pnpm устанавливаются по `mise.toml`; dependency install использует `pnpm install --frozen-lockfile`. GitHub Actions фиксируются на проверенных полных commit SHA.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check -- --changed --base <previous push SHA>`, `pnpm test:unit:affected --base <previous push SHA>` и `pnpm test:self-improve-pr`.
- Result bundle: текстовый manifest с commit SHA, workflow run identity и командами/exit codes; загрузка выполняется и при провале gate. До checkout/setup создаётся начальный manifest, чтобы setup failure тоже оставил доказательство запуска. Каталог задаётся через доступный в job-level `env` контекст `github.workspace`, не через step-only `runner.temp`. Никаких credential values, пользовательских данных или рабочих tree artifacts.
- Запрещено автоматически трактовать green check как разрешение на merge, promotion, release либо запуск evaluator на непроверенном artifact.

## Приёмка

| ID    | Сценарий                                             | Проверяемый результат                                                                                                                                      |
| ----- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-01 | Прямой push в `dev`                                  | Проверяется checkout exact `github.sha`; summary и manifest содержат тот же SHA и comparison base.                                                        |
| CI-02 | Недоверенный PR код                                  | Workflow не запускается для PR; `pull_request_target` не исполняет PR-код; `--apply` остаётся закрытым без отдельного trusted secret-free gate.             |
| CI-03 | Любой gate падает                                    | Run красный, итоговый manifest/log artifact всё равно загружается и указывает упавшую команду.                                                             |
| CI-04 | Все gates проходят                                   | Run зелёный только после install/typecheck/lint/architecture/affected tests/self-improve tests; output явно ограничивает claim прохождением этих проверок. |
| CI-05 | PR в другую ветку или release event                  | Этот workflow не запускается; он не меняет теги, Releases, ветки, PR и deployment feeds.                                                                   |
| CI-06 | Checkout или установка toolchain завершается ошибкой | Начальный manifest загружается; он не помечает непроизведённые проверки как пройденные.                                                                    |
| CI-07 | Открыт/обновлён PR в `dev`                            | Этот workflow не исполняет PR-controlled policy; отдельный trusted secret-free gate обязателен для автоматического допуска.                                |
| CI-08 | Прямой push в `dev`                                  | На точном pushed SHA запускаются те же gates; база affected/architecture checks — SHA до push, а PR-only поля не требуются.                                |
| CI-09 | Workflow run на `push` в `dev`                       | Run содержит job и checks; пустой run с `failure` и нулём jobs не считается проверкой и должен обнаруживаться как дефект конфигурации.                     |
| CI-10 | PR проверка                                         | Проверка кандидата не считается активной, пока не создан отдельный trusted workflow вне PR-controlled policy.                                               |
| CI-11 | Контексты GitHub Actions                             | Workflow проходит `actionlint`; expressions используют только разрешённые в соответствующем поле contexts.                                                 |
| CI-12 | Workflow изменён в same-repository PR                | Candidate workflow не запускается для этого PR; изменение workflow нельзя использовать для выдачи себе права на secrets или promotion.                      |
