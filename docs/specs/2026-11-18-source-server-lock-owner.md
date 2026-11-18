# Source Server: владелец data-root lock при переиспользовании PID

## Проблема

`run/server.lock` защищает data root от второго Supervisor. Lock хранил только `pid` и `acquiredAt`, а проверка живости сводилась к `process.kill(pid, 0)`.

После падения Server его PID может достаться постороннему процессу. Наблюдаемый случай: lock указывал на `pid: 756`, а `/proc/756/cmdline` содержал `/usr/sbin/qemu-ga`. Проверка считала владельца живым, Supervisor падал с `Another ZCode Server instance is already running`, systemd запускал его повторно, счётчик restart доходил до лимита, а `status.json` оставался в старом `ready` от предыдущей версии.

Итог для пользователя: установка новой версии завершалась ошибкой `Timed out waiting for Server ready`, хотя SSH и файлы обновления были в порядке.

## Владение состоянием

- Supervisor — единственный владелец `run/server.lock`; он пишет lock при старте и удаляет при штатном завершении.
- CLI, `shutdownWait`, `updateHandoff` и `uninstallGuard` только читают lock через `DataRootLock.inspect()`.
- Recovery gate (`server.lock.recovery`) и quarantine по-прежнему сериализуют конкурентное восстановление stale lock.
- `status.json` не переписывается при отказе в захвате lock: запись статуса начинается после успешного `acquire()`.

## Контракт lock

Lock-запись содержит:

| Поле             | Назначение                                        |
| ---------------- | ------------------------------------------------- |
| `pid`            | PID процесса-владельца                            |
| `processStartId` | Идентичность инстанса процесса (новые lock)       |
| `acquiredAt`     | Время захвата                                     |
| `ownerToken`     | Токен для безопасного удаления только своего lock |

`processStartId`:

- Linux: поле 22 (`starttime`) из `/proc/<pid>/stat`; поле читается после последней `)`, чтобы `comm` с пробелами не сдвигал индексы.
- macOS: `ps -p <pid> -o lstart=`.
- Платформы без поддерживаемого источника: поле отсутствует, поведение остаётся консервативным.

`isHolderAlive(pid, processStartId)`:

- `pid` отсутствует или `kill(pid, 0)` вернул `ESRCH` → stale.
- `EPERM` → процесс существует; дальше проверяется идентичность.
- Зомби (`Z`) и мёртвый (`X`) в `/proc/<pid>/stat` → stale.
- Новый lock и доступный `processStartId` → живой только при точном совпадении.
- Legacy lock без `processStartId` → живой, если командная строка содержит `zcode`, `server-cli` или `server-core` (release запускается как `runtime/server-cli.js`, включая нестандартный `--server-root`).
- Командная строка недоступна (нет прав, нет `ps`, неподдерживаемая платформа) → живой, чтобы не украсть lock у работающего Server.
- Lock, записанный текущим процессом, проверяется по тому же `processStartId`; при его отсутствии считается живым.

## События

```text
Supervisor A: acquire -> lock {pid, processStartId, ownerToken}
Supervisor A: crash
OS: pid -> unrelated process
Supervisor B: read lock -> startId mismatch -> inspect stale
Supervisor B: recovery gate -> raw compare -> claim stale path
Supervisor B: acquire -> lock {pid B, processStartId B} -> starting -> ready
```

Конкурентный старт:

```text
Supervisor B и C: read same live lock -> startId совпал -> already running
```

## Границы

- Проверка не убивает и не перезапускает посторонний процесс с совпавшим PID.
- Stale Supervisor, который ещё держит lock живым процессом, не удаляется автоматически: это отдельный сценарий с собственным подтверждением.
- `status.json` от прошлого запуска не считается доказательством живости; CLI по-прежнему ждёт новый persisted `ready` после своего baseline.

## Приёмка

- Lock с несовпадающим `processStartId` перехватывается, новый lock содержит строковый `processStartId`.
- Legacy lock, чей PID теперь принадлежит другой команде, перехватывается.
- Legacy lock с живой командной строкой `server-cli` не перехватывается.
- Существующие проверки «ровно один владелец» и восстановление после битого lock остаются зелёными: `packages/zcode-server-cli/test/lock.test.ts`.
