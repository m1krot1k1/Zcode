# shared-voice-dictation

Cross-process types for local voice dictation.

- Contract only: no runtime, filesystem, Electron, or model code.
- One platform port (`VoiceDictationPort`) with status/catalog/prepare/start/
  appendAudio/stop/cancel and bounded events.
- Audio buffers cross as `ArrayBuffer`; the bearer token, absolute model paths,
  and transcript logs do not.
- Owned by the Desktop main adapter (`desktop-voice-dictation`) and consumed by
  `ui-voice-dictation`.
