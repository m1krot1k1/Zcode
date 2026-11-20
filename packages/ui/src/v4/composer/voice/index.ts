/**
 * ui-voice-dictation public surface.
 *
 * The module owns the renderer-side dictation lifecycle: platform port access,
 * audio capture, model/language choice, the in-app shortcut, and Lexical text
 * projection. It never owns the Agent model, sends a turn, or writes the draft
 * outside the existing Lexical editor path.
 */
export type { VoiceDictationApi } from "./useVoiceDictation.js";
export type { VoiceDictationState, VoiceDictationStatus } from "./voiceDictationController.js";
export { useVoiceDictation } from "./useVoiceDictation.js";
export { VoiceDictationButton, VoiceDictationOverlay } from "./VoiceDictationControls.js";
