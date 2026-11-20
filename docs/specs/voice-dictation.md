# Voice dictation (Hex engine)

Status: macOS arm64 implementation verified against the bundled engine; Windows/Linux
build artifacts are produced by the same script but were not run in this checkout.
Owner: Desktop Host. Applies to the local Desktop app; Web and remote workspaces expose no
dictation surface.

## Goal

ZCode ships local, on-device voice dictation powered by a bundled `hex-service` (Hex, MIT). The user
presses a microphone control (or a shortcut), speaks, and sees text appear in the Composer while they
speak. No audio leaves the machine, no Hex desktop app or system-wide paste is required, and speech
models are downloaded and managed from ZCode itself.

Non-goals: system-wide dictation outside ZCode, replacing the Agent model, meeting recording, screen
annotation, and cloud speech providers.

## Product surface

- A microphone button sits in the empty-state start composer and in the ordinary conversation Composer
  toolbar. It starts and stops one dictation for the focused Composer only.
- While dictating, an in-window overlay appears above the Composer: level meter, elapsed time, selected
  model/language, and Stop/Cancel. It never creates an OS-level floating window.
- The shortcut defaults to in-app hold-to-talk and double-tap-to-toggle. A Settings switch may register
  the toggle globally while ZCode is running; global hold-to-talk is not promised until the platform
  input bridge exists. The shortcut acts only on the active ZCode Composer.
- Settings › Voice owns: enabled state, shortcut mode, language, installed model, catalog download with
  progress, and disk usage. The catalog shows the provider's own name, languages, size, and whether the
  model can stream partial text.
- Live text is appended at the Composer caret. `stable` text is never revised; `tentative` text is
  replaced by the next partial for the same segment. On stop, the final transcript replaces the
  tentative tail. Cancel removes all text inserted by that dictation and keeps the prior draft.
- Dictation never sends a message, never starts a turn, and never changes the selected Agent model.

## Ownership and process model

- One `hex-service` child per Desktop window Host, started lazily on the first dictation or model action
  and reused across dictations. It is a direct child of the Host (not the renderer), owns model memory,
  and exits with the Host. The Host reads only the service's `{"type":"ready"}` line and its bearer token;
  the token never reaches the renderer.
- The renderer owns microphone capture and Composer projection. Audio is 16 kHz mono `s16le`, produced by
  an AudioWorklet, sent in 100–500 ms chunks to the Host over the existing RPC boundary, and never written
  to disk.
- The Host owns the Hex API client, model lifecycle, download progress, cancellation, and the stream
  lease. It exposes bounded methods to the renderer; no renderer code calls localhost or reads the
  discovery file.
- The existing Composer draft remains the single owner of what the user has typed. Dictation is an input
  source that edits the draft through the same Lexical path as typing; it does not create a second draft
  or a pending send.

```mermaid
sequenceDiagram
  participant UI as Composer / Voice overlay
  participant Host as Desktop Host voice service
  participant Hex as hex-service
  participant Models as Model host
  UI->>Host: startDictation(language, model)
  Host->>Hex: POST /streams (f32le/s16le, 16 kHz)
  Hex-->>Host: 201 {id, ownerToken, partials}
  loop while speaking
    UI->>Host: appendAudio(chunk)
    Host->>Hex: POST /streams/{id}/audio
    Hex-->>Host: SSE partial/segment
    Host-->>UI: stable/tentative text
  end
  UI->>Host: stopDictation()
  Host->>Hex: POST /streams/{id}/finish
  Hex-->>Host: final text
  Host-->>UI: final replacement
```

## Hex integration

- The repository pins a Hex commit and applies two local patches in
  `scripts/hex-service/patches/`: an embedded service that creates and shares a
  `TranscriptionEngine` so `/streams` works headlessly, and a stub for the Apple Intelligence Swift
  bridge so the service builds with Command Line Tools-only macOS installations. Dictation does not
  depend on Apple Intelligence.
- `scripts/prepare-hex-service.mjs` builds `hex-service` for the target platform into
  `packages/desktop/bundled-voice/<platform>/hex-service` (or verifies a prebuilt artifact supplied by
  CI), writes a manifest with version/commit/sha256, and never downloads models at build time. The
  `hex` MIT license and third-party notices are shipped next to the binary and added to
  `THIRD-PARTY-NOTICES.md`.
- macOS builds must be signed with the app's Developer ID; the upstream Hex signature is not reused.
  Windows/Linux artifacts are produced by the platform CI job. The app reports a clear unavailable state
  when the binary is missing or cannot run, and never silently downloads an executable at runtime.
- Model downloads are performed by the bundled service through its `/models/{id}/prepare` endpoint,
  with the same bytes and progress events Hex itself uses. Download failures leave the previous model
  usable. Models are stored under the app data directory and are removable from Settings.

## Model and language behavior

- The catalog comes from `GET /models`; it includes `id`, `name`, languages, bytes, installed/verified,
  and the model's streaming capability. Language selection filters the catalog; `auto` is offered only
  when the model supports detection.
- A model marked as streaming produces `partial` events (`stable` + `tentative`) while the user speaks.
  Models without streaming produce `segment` events at pauses and a final transcript on stop; the UI says
  "Текст появится на паузах" instead of promising word-by-word typing.
- The first dictation in a language that has no installed model opens the model picker with the
  recommended model and its download size; it does not start a hidden download.
- At most one live stream exists. A second start while one is active is refused in the UI; the Host
  cancels the previous stream on window close or renderer unload.

## Failure, privacy, and capacity

- Audio stays in memory and is sent only to the loopback Hex service. Logs never contain audio,
  transcript text, tokens, or absolute model paths; diagnostics use stable error codes and sizes.
- Microphone permission is requested through the existing platform permission path. Denial leaves the
  Composer editable and shows an actionable notice.
- `stream-busy`, `lease-expired`, `model-not-loaded`, `engine-unavailable`, download failures, and
  process crashes each have a distinct user-visible state. A crash kills the child and the next start
  relaunches it once; it must not loop.
- Stop waits for the final transcript with a bounded deadline; if it expires, the Host cancels the stream
  and keeps the stable text, reporting a truncated dictation instead of hanging.
- One service per window bounds model memory; models are unloaded/replaced only through the service.
  Idle shutdown is explicit and must not drop a model during an active dictation.

## Acceptance scenarios

- First use: open Settings › Voice, choose Russian, pick GigaAM v3, see download progress complete, then
  dictate in the start composer; text appears while speaking or at pauses and lands at the caret.
- Existing draft: place the caret mid-text and dictate; inserted text appears at the caret, the rest of
  the draft is unchanged, and no send occurs.
- Streaming model: with a Parakeet streaming model, tentative words update smoothly and never duplicate
  stable text; on stop the final transcript replaces the tentative tail exactly once.
- Non-streaming model: the overlay shows the "text at pauses" state; segments append without waiting for
  release and the final replaces the loose tail.
- Cancel (Escape or Cancel): all text inserted by the current dictation is removed and the pre-dictation
  draft/selection is restored.
- Shortcut: in-app hold starts on keydown and stops on keyup; double-tap toggles; shortcuts do nothing
  when another app is focused unless the global toggle is explicitly enabled.
- Permission denied, missing model, service crash, stream busy, and lease expiry each show a distinct,
  localized message; the Composer remains usable and no partial message is sent.
- Code-index descriptor regression: a 20k-file workspace can open while Hex is running; the Host keeps
  enough descriptors to spawn the Agent CLI and the dictation child.
- Cross-platform: macOS arm64/x64, Windows x64/ARM64, and Linux x64/ARM64 builds either ship a verified
  `hex-service` and pass the same start/stop scenario, or report the capability unavailable with the
  missing-artifact reason.

## Verification

- 2026-11-20, macOS arm64: patched Hex 3.4.0 embedded service; `GET /models` reported GigaAM v3 as
  installed/verified; `/transcriptions` returned Russian text; Parakeet Unified English `/streams`
  emitted `partial` events before `final`.
- The same build fed the Composer through the platform port: Russian text appeared in the Lexical
  editor during recording and the final replaced it once; cancel restored the prior draft in the
  editor unit tests.
- The Desktop main process exposed status, catalog, prepare, start, appendAudio, stop, and cancel over
  the `zcode:voice-dictation` channel; no token or model path crossed to the renderer.
- Not verified here: Windows/Linux binaries, real-microphone TCC approval on a clean machine, and a
  global hold shortcut. The current shortcut is in-app (hold ⌘⇧Space, tap twice to keep recording);
  a global toggle is a deliberate follow-up rather than a hidden partial path.
