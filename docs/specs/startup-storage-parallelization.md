# Startup storage preparation and reopen latency

Status: active (2026-11-23, release 3.17.156)

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
- The session preparation Worker must exit as soon as it writes
  `startup/storagePrepared`. It must not depend on stdin EOF or the generic 1 s CLI exit
  watchdog: the Worker keeps the stdin readable handle alive, so waiting added a fixed
  ~1 s to every reopen. The completion frame is written with an output-write callback and
  the database is already closed before exit.
- The bundled CLI/agent process runs with `NODE_COMPILE_CACHE` under
  `{appConfigDir}/cache/node-compile`. Node reuses V8 bytecode for the 20 MB bundle;
  measured cold start dropped from ~800 ms to ~610 ms on the same machine. The cache is
  rebuildable and has no protocol or database semantics.

## Measured effect (macOS arm64, release 3.17.156)

Before: `storage_total` 1778 ms, of which `session_storage` 1777 ms; `services_ready`
1808 ms. After on the built 3.17.156 app: first launch `storage_total` 836 ms,
`services_ready` 852 ms; second (warm compile cache) launch 567 ms and 583 ms. The
isolated Worker exits at ~740 ms instead of ~1755 ms. The Host no longer waits for the
watchdog.

## Acceptance

- Both `prepareHostStorage` and `prepareSessionStorage` are invoked before either resolves.
- The last session database is the only one with `finalDatabase: true`.
- A failure in either branch prevents service initialization and surfaces the existing
  storage error/retry state.
- Startup log contains one timing line per phase with a numeric duration.
- `hostDatabaseStartup.test.ts` and `storagePreparationWorker.test.ts` pass.
