# Code-index worker must be shipped as its own bundle

Status: active (2026-11-23, release 3.17.157)

## Problem

`IndexWorkerClient` runs the index scanner/AST/SQLite pipeline in a `node:worker_threads`
worker. It resolves the worker as `indexWorker.js` next to `code-intelligence` module in the
Host bundle. If the file is missing, it deliberately falls back to the same engine in the
Host thread.

The packaged Desktop build bundled `IndexWorkerClient` into `out/host/index.js` and
`out/host/chunk-*.js`, but never emitted `out/host/indexWorker.js`. In the 3.17.156
artifact `app.asar` contained `out/host/index.js` and `tasksStorageWorker.js` but no
`indexWorker.js`.

Consequences on a large workspace (16k files, 312k symbols, 360k edges, index in progress):

- full scan/AST/SQLite work ran on the Host event-loop thread;
- `code-intelligence.getStatus` took **14,736 ms**;
- renderer RPCs (`project.prepareSession`, `model-selection.getView`, `setting.update`)
  queued behind it;
- click → `main_turn` took **15,593 ms**, while on a tiny workspace with a ready index it
  took **165 ms**.

This is separate from ghost autocomplete; autocomplete was not present in either run.

## Contract

- The Desktop `host` tsup config emits
  `host/indexWorker: ../services/src/code-intelligence/worker/indexWorker.ts`.
- The worker module itself owns `workerData`, `parentPort`, request validation and the
  `CodeIndexService` instance; the build config only supplies the entry path.
- The emitted file stays next to `out/host/index.js` and the host chunks so
  `IndexWorkerClient` can resolve it both in development and inside `app.asar`.
- The entry is a build contract: changing/removing it must fail
  `tsupChunkIsolation.test.ts` and the packaged-artifact check.
- The in-process fallback remains for tests and environments without the compiled worker,
  but production Desktop must not use it.

## Verification

- `packages/desktop/out/host/indexWorker.js` exists after `tsup`; a direct worker request
  returns a valid `status` result.
- `tsupChunkIsolation.test.ts` asserts the `host/indexWorker` entry.
- Rebuilt Desktop 3.17.157 measurement on the large workspace: click → `main_turn`
  should be bounded by RPC/serialization (~1 s or less), not by the index pass.
- `pnpm typecheck`, `pnpm lint`, `architecture:check --changed` and focused tests pass.
