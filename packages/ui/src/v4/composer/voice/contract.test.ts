import { describe, expect, it } from "vitest";

import { uiVoiceDictationModule } from "./module.js";

// The public surface is a hook + two components; behavior is covered by
// voiceDictationEditor.test.ts and the Composer integration tests.
describe("ui-voice-dictation contract", () => {
  it("declares its module manifest", () => {
    expect(uiVoiceDictationModule.id).toBe("ui-voice-dictation");
    expect(uiVoiceDictationModule.publicEntrypoints).toContain("index.ts");
  });
});
