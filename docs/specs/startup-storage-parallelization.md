# Startup storage preparation and reopen latency

Status: active (2026-11-22, release 3.17.155)

App startup previously prepared two independent SQLite stores one after another:

1. the Host task index (`tasks-index.sqlite`), through a Node worker;
2. the session store for each warmup workspace, through the bundled agent
   `--prepare-storage` entry.

Each step pays worker/process startup and migration discovery. Sequential execution added
those costs to every reopen. The Host now starts both preparations concurrently and waits
for both before initializing services.

## Contract

- `tasks-index.sqlite` and the session database are separate files and have no ordering
  dependency. `createHostDatabaseStartup` starts both preparations before awaiting either.
- The session databases themselves stay ordered: `finalDatabase: true` is reported only
  for the last directory in the warmup list, so global save/finish applies once.
- Disk sampling starts once; both paths are observed through the same sampler. A skipped
  sample is a `partial` disk summary, never a storage failure.
- `initializeServices()` runs only after both preparations succeed. A failure is still
  retryable through the existing startup coordinator.
- `onTiming(phase, durationMs)` reports `tasks_storage`, `session_storage`,
  `storage_total`, and `services_ready`. The Host logs them as
  `database startup phase { phase, durationMs }` for before/after measurement.

## Acceptance

- Both `prepareHostStorage` and `prepareSessionStorage` are invoked before either resolves.
- The last session database is the only one with `finalDatabase: true`.
- A failure in either branch prevents service initialization and surfaces the existing
  storage error/retry state.
- Startup log contains one timing line per phase with a numeric duration.
- `hostDatabaseStartup.test.ts` and `storagePreparationWorker.test.ts` pass.
