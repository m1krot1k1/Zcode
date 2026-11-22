export const desktopVoiceDictationModule = {
  id: "desktop-voice-dictation",
  requires: ["shared"],
  provides: ["desktop-voice-dictation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
