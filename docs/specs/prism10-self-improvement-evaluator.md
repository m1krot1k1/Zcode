# PRISM10 локальная проверка инфраструктуры самоулучшения

## Цель и границы

Добавить локальную команду, которая наблюдает выполнение одного фиксированного self-test для уже закоммиченной базы `HEAD`, сохраняя evidence только о состоянии инфраструктуры evaluator/helper.

Staged LLM candidate никогда не загружается, не импортируется и не запускается этой командой. Его `HEAD` и SHA-256 staged patch записываются только как контекст запуска. `VALIDATED_LOCAL` означает исключительно, что фиксированный self-test trusted `HEAD` snapshot завершился с кодом 0 и его вывод сохранён; это не результат, оценка качества или подтверждение candidate.

Команда не создаёт ветки, коммиты, PR или releases. Существующий dry-run self-improve PR plan остаётся доступен. Фактический `--apply` блокируется, пока в репозитории нет заранее существующего внешнего защищённого secret gate; локальный env-флаг или receipt таким gate не считается.

## Единственный владелец и порядок событий

`scripts/self-improve-evaluator.mjs` владеет admission staged patch, извлечением минимального trusted test snapshot из Git объектов `HEAD`, запуском allowlist и локальным evidence. `scripts/self-improve-pr.mjs` сохраняет dry-run планирование и проверяет receipts; единственный текущий criterion явно ограничен инфраструктурой `HEAD`.

```text
dev + HEAD + staged index
  → проверить staged-only состояние, secret-like paths и отсутствие изменений trusted evaluator/check fixtures
  → вычислить HEAD SHA и точный SHA-256 staged patch, не загружая candidate-файлы
  → проверить типы Git objects fixed self-test файлов в HEAD (обычные blobs; не symlink/gitlink)
  → создать минимальный read-only по смыслу temp snapshot только из этих HEAD blobs вне checkout
  → запустить фиксированный Node self-test в snapshot, с ограниченным env и деревом процессов
  → сохранить stdout/stderr и пересчитать artifact SHA-256
  → только при наблюдённом exit 0 выдать receipt v3 со scope HEAD_INFRASTRUCTURE_ONLY
  → отдельный self-improve CLI может показать dry-run план; фактический --apply заблокирован без внешнего protected gate
```

## Admission и snapshot

- CLI принимает только необязательный `--evidence-dir <path>`; команда, executable, argv, exit code, timestamp, artifact hash, base SHA и patch hash не принимаются от вызывающего.
- `HEAD` должен быть на `dev`; допускаются только staged изменения без unstaged, untracked, rename/copy, secret-like пути или изменений evaluator/allowlist/test fixtures.
- Candidate path, symlink и gitlink никогда не используются как snapshot source. Фиксированные helper и test bytes читаются через Git object database по exact `HEAD` path/object id; требуются blob mode `100644` или `100755`. Snapshot создаётся отдельным temp каталогом с обычными файлами, без `.git`, submodule traversal или worktree link.
- Snapshot включает только фиксированные файлы, необходимые self-test: helper, его shared receipt contract и тест. Они должны быть точными blobs из проверенного `HEAD`; если объект отсутствует, имеет иной mode/type или не копируется, evaluator завершает работу без receipt.
- Evidence создаётся с приватными правами вне checkout; candidate patch и self-test snapshot остаются разными каталогами.

## Allowlist, evidence и процессы

- Единственный criterion: `SELF-IMPROVE-HEAD-INFRASTRUCTURE-TESTS`, команда `node --test scripts/test/self-improve-pr.test.mjs`, запускаемая из минимального exact-HEAD snapshot через `process.execPath` и `spawn(..., shell: false)`.
- Child получает только разрешённые системные env keys. Staged candidate source не доступен ему через cwd, module resolution или импорт.
- Один timeout — 5 минут; stdout+stderr ограничен 10 MiB. На POSIX runner запускает отдельную process group, посылает ей `SIGTERM`, ждёт завершения до секунды, затем при необходимости посылает `SIGKILL` и ждёт ещё до секунды. На Windows runner завершает дерево через системный `taskkill /T /F`; если системное завершение дерева недоступно или не подтверждено, receipt не выдаётся.
- Timeout, spawn error, сигнал, ненулевой exit code, output cap, snapshot/admission ошибка или artifact-write/hash ошибка завершают evaluator без receipt. Диагностический artifact может остаться.
- Receipt schema `zcode.prism.receipt.v3` содержит `evaluation_scope: "HEAD_INFRASTRUCTURE_ONLY"`. Статус `pass` относится только к этому фиксированному infrastructure self-test; scope проверяется повторно PR helper-ом. Результат не называется semantic evaluation или candidate pass.
- Receipt не является подписанной или внешне аттестованной записью. Локальный владелец контролирует ОС и Git object database; для promotion и применения изменений нужен отдельный защищённый gate и человеческое решение.

## Dry-run и защищённая публикация

- Dry-run `scripts/self-improve-pr.mjs --evidence <receipt>` остаётся read-only и может построить draft plan по staged diff и инфраструктурному receipt с явным предупреждением, что candidate не оценивался.
- `--apply` завершается отказом до `git fetch`, branch creation, commit, push или GitHub CLI вызовов, поскольку заранее существующий защищённый secret gate пока не настроен.
- Возобновлять apply можно только после подключения и независимой проверки внешнего gate, который до публикации сканирует точный staged patch и защищает credentials. Сам факт receipt, env-переменная или post-push CI не удовлетворяют этому условию.

## Критерии приёмки

| ID           | Сценарий                                                              | Ожидаемый результат                                                                                                                   | Проверка                                                 |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| EVO-LOCAL-01 | Valid staged patch на dev                                             | Только exact-HEAD self-test исполняется; receipt scope равен `HEAD_INFRASTRUCTURE_ONLY`; вывод действительно получен от child process | Temp Git CLI integration и парсер receipt v3             |
| EVO-LOCAL-02 | Candidate helper содержит top-level sentinel side effect              | Sentinel отсутствует; тест выполняет helper bytes из HEAD snapshot                                                                    | Regression integration test                              |
| EVO-LOCAL-03 | Фиксированный self-test не проходит, timeout или output limit         | Нет receipt; завершено всё дерево процессов                                                                                           | Real child failure, timeout/output cap и descendant test |
| EVO-LOCAL-04 | Candidate пытается заменить helper/test symlink или gitlink/submodule | Отказ до исполнения; snapshot всё равно строился бы только из HEAD blobs                                                              | Symlink и gitlink fixtures                               |
| EVO-LOCAL-05 | Checkout является linked worktree                                     | Admission и HEAD object extraction используют правильный worktree HEAD; candidate source не запускается                               | Temporary Git worktree integration                       |
| EVO-LOCAL-06 | CLI получает команду, exit code или artifact hash                     | Отказ до snapshot и child spawn                                                                                                       | CLI parser tests                                         |
| EVO-LOCAL-07 | `self-improve-pr.mjs` повторно читает receipt                         | Принимаются только v3 receipt с exact allowlist, scope, base, patch hash и локально пересчитанным artifact                            | Integration с `parseCandidateEvidence`                   |
| EVO-LOCAL-08 | `--apply` вызывается без pre-existing external protected gate         | Отказ до любого write/network command; dry-run продолжает работать                                                                    | Fake command runner проверяет ноль вызовов               |
| EVO-LOCAL-09 | Ветка не `dev`, unstaged/untracked/rename/copy/secret-like path       | Отказ до snapshot, process execution и evidence                                                                                       | Temp Git admission tests                                 |

## Ограничения

Этот срез проверяет только работоспособность доверенного helper/test кода на закоммиченном `HEAD`; он не запускает candidate и не сообщает, хорош ли его diff. Local artifact не является attestation. Пока нет отдельно проверенного внешнего secret gate, PR helper намеренно не выполняет apply. Trusted `HEAD` self-test — обычный Node-код и его subprocesses, поэтому runner ограничивает env, timeout, output и process tree, но не является полной OS sandbox; абсолютная защита требует изолированной CI/VM среды.
