// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const api = {
    state: {
      status: "error" as const,
      available: true,
      reason: null,
      models: [
        {
          id: "parakeet_unified_en",
          name: "Parakeet Unified English",
          languages: ["en"],
          installed: true,
          verified: true,
          downloadBytes: 1,
          streams: true,
        },
      ],
      modelId: "parakeet_unified_en",
      language: "en",
      mode: "streaming" as const,
      progress: null,
      error:
        "Error invoking remote method 'zcode:voice-dictation': Error: stream-start-503: model-not-loaded",
      startedAt: 1,
      level: 0,
      stable: "",
      tentative: "",
      settingsOpen: false,
    },
    supported: true,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    selectModel: vi.fn(),
    selectLanguage: vi.fn(),
    prepareModel: vi.fn(),
    refreshModels: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  return { api, openSettingsTab: vi.fn(), setPending: vi.fn() };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ voiceDictation: {} }),
  useOptionalPlatform: () => ({ voiceDictation: {} }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { openSettingsTab: () => void }) => unknown) =>
    selector({ openSettingsTab: mocks.openSettingsTab }),
}));
vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: mocks.setPending,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./useVoiceDictation.js", () => ({
  useVoiceDictation: () => mocks.api,
}));

import { VoiceDictationOverlay } from "./VoiceDictationControls.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("voice dictation overlay settings action", () => {
  it("navigates to Settings › Voice instead of opening a duplicate modal", () => {
    render(<VoiceDictationOverlay />);

    // The overlay sits over the native window titlebar; without no-drag Electron
    // consumes every click even though hover/tooltip still work.
    expect(screen.getByTestId("voice-dictation-overlay").className).toContain(
      "[app-region:no-drag]",
    );

    fireEvent.click(screen.getByRole("button", { name: "chat.voice.openSettings" }));

    expect(mocks.setPending).toHaveBeenCalledWith("voice");
    expect(mocks.openSettingsTab).toHaveBeenCalledTimes(1);
    expect(mocks.api.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it("shows a localized model-load message instead of the Electron IPC wrapper", () => {
    render(<VoiceDictationOverlay />);

    expect(screen.getByText("chat.voice.modelLoadFailed")).toBeTruthy();
    expect(screen.queryByText(/Error invoking remote method/u)).toBeNull();
  });
});
