# cli-exec-sandbox

Модуль отвечает за две неразделимые гарантии: **реальную** ОС-изоляцию процесса и
**гарантированное** уничтожение дерева процессов. Владелец состояния — процесс CLI:
кэш зондирования живёт в `SandboxCapabilityCache` (TTL 60 с), сами сессии не хранятся.

## Инварианты

1. **Честность режима.** Каждый `wrap()` возвращает `sandboxMode` из
   `bwrap | seatbelt | degraded | none`. Значение `bwrap`/`seatbelt` выставляется
   только после успешного самотеста механизма (`probe()` выполняет реальный запуск
   `/bin/true` внутри неймспейса). Отсутствие механизма никогда не маскируется
   исключением или пустой обёрткой.
2. **Degraded — защита, не заглушка.** В `degraded`: `cwd` принудительно внутри
   workspace, окружение собирается только из `SANDBOX_ENV_WHITELIST` +
   явного `policy.env`, лимиты применяются через `sh -c 'ulimit ...; exec "$@"'`.
   `filesystemIsolated` и `networkIsolated` остаются `false`, причина заполнена.
3. **Запись только в разрешённые корни.** В `bwrap` и `seatbelt` вся корневая ФС
   read-only; writable ровно `workspacePath` + `writableRoots` + temp. Критические
   пути (`<ws>/.git/hooks`, `<ws>/.zcode`, `~/.ssh`, `~/.gnupg`, `~/.aws`)
   возвращаются в read-only **после** writable-bind.
4. **`cwd` не выходит за workspace.** `normalizePolicy` схлопывает внешний `cwd` в
   корень workspace, иначе degraded-граница перестаёт существовать.
5. **Ключ изоляции.** Политика адресуется `workspaceIdentity?.trim() || workspacePath`;
   модуль не парсит identity сам, а получает готовый `workspacePath`.
6. **`killTree` идемпотентен.** Уже завершённый корень → `alreadyExited: true`.
   PID 1, собственный PID вызывающего и чужие PID не сигналятся. После
   `SIGTERM` выдерживается `graceMs` (1 500 мс по умолчанию), затем `SIGKILL`,
   затем отчёт `survivors`.
7. **Windows не ломается.** `wrap()` на `win32` возвращает `sandboxMode: "none"`
   с причиной и не меняет argv: существующий путь исполнения сохраняется.
   `killTree` использует `taskkill /T /F`.

## Пересечения с другими модулями

- `cli-exec-pty` использует `wrap()` для shell внутри PTY и `killTree()` при
  `kill`/`dispose`: песочница и PTY обязаны делить одну политику режима.
- `bash`-инструмент агента получает `sandboxMode` и `sandboxReason` из результата
  `wrap()`; модель видит фактический режим, а не запрос.
