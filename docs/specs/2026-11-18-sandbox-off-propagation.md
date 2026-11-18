# Проброс `sandboxSettings.mode = off` в CLI

> Статус: реализовано 2026-11-18. Заменяет утверждение старой спеки
> [`2026-11-11-bash-sandbox-honesty.md`](./2026-11-11-bash-sandbox-honesty.md)
> о том, что OS-sandbox отсутствует: bwrap/seatbelt уже выполняются, но
> настройка Host до них не доходила.

## 1. Проблема

`setting.json` хранил `sandboxSettings.mode`, Host отправлял его в
`runtimePreferences`, однако CLI терял значение при сборке `runtimeConfig`.
В результате:

- Bash всегда использовал `workspace-write` и оборачивал команду в bwrap;
- PTY по умолчанию использовал `workspace-write`;
- `buildSandboxEnv` фильтровал окружение по whitelist даже при profile `off`,
  поэтому терялись `GH_CONFIG_DIR`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME` и другие
  переменные пользователя;
- `gh auth status` и ssh-agent работали не так, как в обычном терминале.

## 2. Контракт

| Значение `mode`          | Bash/PTY                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `off` (default)          | Без bwrap/seatbelt, полное окружение процесса, `sandbox.mode = none`                      |
| `auto` / `bwrap`         | `workspace-write`; bwrap на Linux, деградация с честным отчётом, если механизм недоступен |
| `seatbelt`               | `workspace-write`; seatbelt на macOS, та же деградация                                    |
| `allowBashNetwork=false` | `networkAccess=deny` для Bash и PTY                                                       |

`off` — явное решение пользователя, а не деградация. Он не должен
подменяться на bwrap и не должен очищать окружение.

### 2.1. Владельцы и порядок

```
setting.json (Stage4Settings)
   │ resolveStage4Settings: auto → off
   ▼
Host runtimePreferences { sandboxMode, sandboxAllowNetwork }
   ▼
CLI resolveSessionStartupPreferences
   ├─ новая сессия: значения Host
   └─ inherit/fork: снимок ZCodeProtocolSessionRecord
   ▼
AgentRuntimeConfig
   ▼
ToolExecutorDeps
   ▼
ToolExecutionContext { bashSandboxMode, bashSandboxNetwork }
   ├─ Bash handler → ExecutionSandboxPolicy(profile)
   └─ PTY handler → SandboxPolicy(profile, networkAccess)
   ▼
ExecutionSandbox.wrap
   ├─ off/none: полный env, команда без обёртки
   └─ workspace-write: bwrap/seatbelt + whitelist env
```

Единственный владелец настройки — Host. CLI не переопределяет `off` и не
делает собственных fallback-решений, кроме legacy-случая: если старый Host не
прислал `sandboxMode`, CLI сохраняет прежний `workspace-write`.

## 3. Границы

- Provider-visible schema Bash не меняется: переключателя песочницы у модели
  нет.
- `sandboxSettings.mode=off` не отключает permission-слой, hooks и лимиты
  выполнения.
- Явный `bwrap`/`seatbelt` сохраняет прежнюю изоляцию и whitelist env.
- Windows всегда исполняет команду без ОС-песочницы и сообщает `none`.

## 4. Приёмка

1. `pnpm typecheck` и `pnpm lint` проходят.
2. `bash-handler.test.ts`: при `bashSandboxMode=off` в
   `ExecutionRequest.sandbox` уходит `profile: "off"`, а не
   `workspace-write`.
3. `pty-session-tool.test.ts`: без явного `sandboxProfile` PTY получает
   `off`, а `networkAccess` следует настройке.
4. `sandbox-enforcement.test.ts`: profile `off` не изолирует файловую систему
   и сеть, а `GH_CONFIG_DIR`/`SSH_AUTH_SOCK`/произвольная переменная доходят
   до дочернего процесса.
5. Smoke packaged AppImage: новый `setting.json` содержит
   `"sandboxSettings":{"mode":"off"}`.
