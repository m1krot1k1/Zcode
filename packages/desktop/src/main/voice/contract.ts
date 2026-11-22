/**
 * desktop-voice-dictation contract.
 *
 * The service is an adapter behind `IPlatformService.voiceDictation`; callers
 * send start/stop/audio commands and receive bounded events. The Hex bearer
 * token and absolute model paths never cross this boundary.
 */
export type { HexVoiceService } from "./hexVoiceService.js";
