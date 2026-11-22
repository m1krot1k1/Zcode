import { describe, expect, it } from "vitest";

import { desktopVoiceDictationModule } from "./module.js";

describe("desktop-voice-dictation contract", () => {
  it("declares its module manifest", () => {
    expect(desktopVoiceDictationModule.id).toBe("desktop-voice-dictation");
    expect(desktopVoiceDictationModule.publicEntrypoints).toContain("index.ts");
  });
});
