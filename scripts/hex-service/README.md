# Hex voice engine

ZCode bundles [Hex](https://github.com/anomalyco/hex) (MIT) as its local speech
engine. The engine runs as a direct child of the Desktop Host:

```
hex-service service --embedded
```

It prints one `{"type":"ready","url":"http://127.0.0.1:…","token":"…"}` line on
stdout. The Host keeps the token, calls the owner-only loopback API, and never
exposes it to the renderer. Closing the Host's stdin terminates the service.

## Pinned build

- Commit: `36b26f2564e0bcc2668e73165c72c2b739daa7d5`
- Version: `3.4.0`
- Patches:
  - `0001-embedded-shared-engine.patch`: creates and shares a
    `TranscriptionEngine` in `service --embedded`, loads prepared models into it,
    and reports each model's `streams` capability from `GET /models`.
  - `0002-apple-intelligence-stub.patch`: stubs the FoundationModels Swift
    bridge so the service builds on macOS Command Line Tools installations.
    Dictation does not use Apple Intelligence.

`prepare-hex-service.mjs` clones the pinned commit into `.zcode-runtime/hex/`,
applies the patches, builds `hex-service` for the target platform, and writes a
manifest with the commit, patches, and binary SHA-256. Release jobs may instead
set `ZCODE_HEX_SERVICE_BINARY` to a CI-built binary; the script still writes the
manifest. No speech model is downloaded at build time.

## Model downloads

The service downloads models into the per-user Hex data directory through
`POST /models/{id}/prepare?language=<code>` and streams progress as SSE. ZCode
owns the UI; it does not proxy model bytes itself.

## License

Hex is MIT-licensed. Its `LICENSE` and `THIRD_PARTY_NOTICES.md` are shipped with
the binary and mirrored in the repository `THIRD-PARTY-NOTICES.md`.
