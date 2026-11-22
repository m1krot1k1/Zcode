# Superpowers Brainstorming Companion: temporary storage contract

## Goal and ownership

The brainstorming companion stores one session's generated pages, state, PID, and log files either in an explicitly selected project directory or in the operating system's temporary directory. The `start-server.sh` launcher owns temporary-session creation and marks that directory as ephemeral. `server.cjs` consumes `BRAINSTORM_DIR`; if launched directly without it, its fallback is derived from Node's `os.tmpdir()`.

`stop-server.sh` may remove only a launcher-marked ephemeral session that resolves to a direct child of the current OS temporary directory. Project-backed sessions persist after stop. No platform-specific `/tmp` or user/checkout path is a runtime requirement.

```text
start-server.sh
  → resolve OS temp root (Node os.tmpdir; convert native Windows path for Git Bash)
  → create unique session directory + ephemeral marker
  → pass BRAINSTORM_DIR to server.cjs
stop-server.sh
  → stop owned server
  → remove only marked direct child of OS temp root
```

## Acceptance

| ID       | Scenario                                                    | Expected result                                                                             |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| BRAIN-01 | macOS/Linux launch without `--project-dir`                  | Session uses OS temp root, not a hardcoded `/tmp`; server receives the same path.           |
| BRAIN-02 | Windows Git Bash launch without `--project-dir`             | Native temp path is converted to a Bash-compatible path before shell filesystem operations. |
| BRAIN-03 | Direct `server.cjs` launch without `BRAINSTORM_DIR`         | Fallback uses `os.tmpdir()` and creates its session files there.                            |
| BRAIN-04 | Stop a launcher-created temporary session                   | Stop removes only that marked session directory after the process exits.                    |
| BRAIN-05 | Stop a project-backed session or unmarked path under temp   | Session data is preserved.                                                                  |
| BRAIN-06 | Temp-root resolution or ephemeral marker is missing/invalid | Launcher fails with an actionable error and does not fall back to a guessed path.           |

## Validation limits

Automated tests may exercise shell behavior and path rules on the current host. Windows Git Bash behavior must also be verified on a Windows runner before claiming Windows runtime coverage; path-conversion unit fixtures alone do not prove that environment.
