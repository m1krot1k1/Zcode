# desktop-voice-dictation

Main-process adapter for local dictation.

- One child `hex-service` per app; the ready token stays in main.
- Streaming models use `/streams` partials; non-streaming models use rolling
  `/transcriptions` windows (stable text at pauses, tentative text while
  speaking).
- Model download progress and transcripts are bounded events; no audio is
  persisted or logged.
- The renderer accesses this adapter only through
  `IPlatformService.voiceDictation`.
