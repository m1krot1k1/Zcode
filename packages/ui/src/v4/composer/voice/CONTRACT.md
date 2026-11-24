# ui-voice-dictation

Renderer-side voice dictation.

- One owner: `voiceDictationController` holds the active capture, selected model
  and language, and the Lexical range it inserted. The Composer never starts a
  second capture or keeps a parallel transcript.
- The controller also owns the setup state: dictation starts only after the user
  picked an installed model themselves. The Composer control reads that state and
  never decides on its own whether dictation may start.
- The platform port is `IPlatformService.voiceDictation` (desktop only). Web and
  remote surfaces do not render the entry.
- Live text is written through the existing Lexical editor handle
  (`beginVoiceDictation` / `applyVoiceDictation` / `cancelVoiceDictation`);
  stable text is never revised, the tentative tail is replaced, and cancel
  removes only the range inserted by this dictation.
- The in-app shortcut is hold-to-talk plus tap-twice-to-keep-listening. A global
  shortcut is out of scope for this module.

Contract: `index.ts` exports the hook and the two Composer controls. Tests cover
the editor range operations; the Host owns the engine and model downloads.
