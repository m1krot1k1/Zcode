import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * Electron wraps a rejected `ipcRenderer.invoke` in
 * `Error invoking remote method 'channel': Error: <main message>`.
 * The voice overlay must never show that transport string to the user.
 */
export function extractVoiceErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const wrapped = raw.match(/Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]+)$/u);
  const message = (wrapped?.[1] ?? raw).trim();
  return message.length > 0 ? message : "voice-unknown-error";
}

export function describeVoiceError(intl: IntlInstance, error: unknown): string {
  const code = extractVoiceErrorCode(error);
  const lower = code.toLowerCase();
  const has = (...parts: string[]) => parts.some((part) => lower.includes(part));

  if (has("notallowed", "permission", "denied")) {
    return intl.formatMessage({ id: "chat.voice.microphoneDenied" });
  }
  if (has("microphone-unavailable", "devicesnotfound", "notfounderror")) {
    return intl.formatMessage({ id: "chat.voice.microphoneUnavailable" });
  }
  if (has("model-not-installed", "unknown-model", "model_not_installed")) {
    return intl.formatMessage({ id: "chat.voice.modelNotInstalled" });
  }
  if (has("model-not-loaded", "model-load-failed", "model-load-timeout", "stream-start-503")) {
    return intl.formatMessage({ id: "chat.voice.modelLoadFailed" });
  }
  if (has("dictation-already-active", "stream-busy", "already-active")) {
    return intl.formatMessage({ id: "chat.voice.alreadyActive" });
  }
  if (has("voice-input-missing", "voice-input-unavailable")) {
    return intl.formatMessage({ id: "chat.voice.inputMissing" });
  }
  if (
    has(
      "engine-binary-missing",
      "engine-ready-timeout",
      "engine-exited",
      "engine-failed",
      "voice-service-disposed",
      "unsupported-platform",
      "binary-missing",
      "voice-unavailable",
    )
  ) {
    return intl.formatMessage({ id: "chat.voice.unavailable" });
  }
  // A remaining short machine code is a stable diagnostic, not user copy.
  if (/^[a-z0-9_.:-]+$/iu.test(code) && code.length <= 120) {
    return intl.formatMessage({ id: "chat.voice.failed" });
  }
  return code;
}
