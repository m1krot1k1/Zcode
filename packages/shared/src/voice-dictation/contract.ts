/**
 * shared-voice-dictation contract.
 *
 * Bounded platform-facing types for the local Hex voice engine. The renderer
 * sees status/catalog/progress/transcript events only; tokens, absolute paths,
 * audio bytes, and engine internals never enter this contract.
 */
export type {
  VoiceDictationAvailabilityReason,
  VoiceDictationEvent,
  VoiceDictationMode,
  VoiceDictationPort,
  VoiceDictationStartRequest,
  VoiceDictationStartResult,
  VoiceDictationStatus,
  VoiceModelPrepareProgress,
  VoiceModelPrepareStage,
  VoiceSpeechModel,
} from "./index.js";
