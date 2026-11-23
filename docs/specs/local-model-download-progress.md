# Local model download progress and resume

Status: active (2026-11-23, release 3.17.164)

## Problem

The managed Ollama runtime used `ollama pull` as a blocking child process. Settings only
showed a spinner, progress was invisible, and leaving the page made the download look
finished or lost. Restarting the app stopped the active pull; only partial blobs remained.

## Contract

- The Host owns the pull. It calls the local Ollama `POST /api/pull` endpoint with
  `{ name, stream: true }` and parses the NDJSON stream.
- `getStatus()` includes `downloads: LocalEmbeddingDownload[]` while a pull is active or
  failed:
  - `state`: `downloading` | `verifying` | `failed`;
  - `completedBytes` / `totalBytes` when Ollama reports them;
  - `statusText` (for example `pulling manifest`, `pulling <digest>`);
  - `error` for a failed pull.
- The download map lives in the Host runtime, not in a React component. Navigating away
  from Settings does not cancel it; returning re-reads the same status. The UI polls once
  per second while a download is active.
- On success the entry is removed and the model appears in `models`. Ollama manifests are
  also read from disk while the server is stopped, so installed models remain visible
  after a restart.
- If the app exits, the HTTP pull stops; downloaded blobs remain in
  `~/.zcode/tools/local-embeddings/models`. A later pull resumes from those blobs. The UI
  shows the resumed bytes/percentage.
- CLI `ollama pull` remains a fallback when `/api/pull` streaming is unavailable.

## Acceptance

- `bge-m3` download shows increasing 0–100% and byte/status text in the embedding
  settings.
- Leaving and returning to the page during a pull shows the current progress again.
- After an app restart, clicking download resumes from the existing blobs (verified
  83% → 100%).
- Saving embedding settings succeeds both before and after the model is installed.
- Managed chat models use the same progress surface in **Local model**.

## Verification (2026-11-23, 3.17.164)

- Real `bge-m3` pull from the packaged app: 99 progress samples, 0→100%, then
  `bge-m3 is installed and selected`.
- Restart + resume: 83→100%, then save succeeded.
- `pnpm typecheck`, `pnpm lint`, `architecture:check --changed`, `knip`, focused UI and
  runtime tests pass.
