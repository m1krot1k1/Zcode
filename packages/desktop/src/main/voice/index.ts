/**
 * desktop-voice-dictation public surface.
 *
 * Main owns the bundled `hex-service` child, the loopback bearer token, model
 * downloads, and audio streaming. The renderer only sees the platform port;
 * this module is the adapter that serves it.
 */
export { HexVoiceService } from "./hexVoiceService.js";
export { registerVoiceDictationIpc } from "./registerVoiceDictationIpc.js";
