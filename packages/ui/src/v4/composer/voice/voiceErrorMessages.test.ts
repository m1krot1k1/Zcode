import { describe, expect, it } from "vitest";
import { describeVoiceError, extractVoiceErrorCode } from "./voiceErrorMessages.js";

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
};

describe("voice error messages", () => {
  it("strips the Electron IPC wrapper", () => {
    expect(
      extractVoiceErrorCode(
        new Error(
          'Error invoking remote method \'zcode:voice-dictation\': Error: stream-start-503: {"code":"model-not-loaded"}',
        ),
      ),
    ).toBe('stream-start-503: {"code":"model-not-loaded"}');
  });

  it("maps model loading and missing-model failures to actionable copy", () => {
    expect(
      describeVoiceError(
        intl,
        new Error(
          "Error invoking remote method 'zcode:voice-dictation': Error: stream-start-503: model-not-loaded",
        ),
      ),
    ).toBe("chat.voice.modelLoadFailed");
    expect(
      describeVoiceError(
        intl,
        new Error(
          "Error invoking remote method 'zcode:voice-dictation': Error: model-not-installed",
        ),
      ),
    ).toBe("chat.voice.modelNotInstalled");
  });

  it("maps permission and unavailable engine errors", () => {
    expect(describeVoiceError(intl, new Error("NotAllowedError: Permission denied"))).toBe(
      "chat.voice.microphoneDenied",
    );
    expect(describeVoiceError(intl, new Error("engine-binary-missing"))).toBe(
      "chat.voice.unavailable",
    );
  });

  it("does not expose an unknown transport string as-is", () => {
    expect(
      describeVoiceError(intl, new Error("Error invoking remote method 'x': Error: weird")),
    ).toBe("chat.voice.failed");
  });
});
