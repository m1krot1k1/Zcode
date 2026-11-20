import { describe, expect, it } from "vitest";

import { sharedVoiceDictationModule } from "./module.js";

describe("shared-voice-dictation contract", () => {
  it("declares its module manifest", () => {
    expect(sharedVoiceDictationModule.id).toBe("shared-voice-dictation");
    expect(sharedVoiceDictationModule.publicEntrypoints).toContain("contract.ts");
  });
});
