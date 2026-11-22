// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type VoiceFixtureStatus = "idle" | "starting" | "listening" | "stopping" | "error";

interface VoiceFixtureState {
  status: VoiceFixtureStatus;
  available: boolean;
  reason: string | null;
  models: Array<{
    id: string;
    name: string;
    languages: string[];
    installed: boolean;
    verified: boolean;
    downloadBytes: number;
    streams: boolean;
  }>;
  modelId: string | null;
  language: string;
  mode: "streaming" | "rolling" | null;
  progress: null;
  error: string | null;
  startedAt: number | null;
  level: number;
  stable: string;
  tentative: string;
  settingsOpen: boolean;
}

interface FakeTab {
  id: string;
  kind: "settings" | "workspace";
}

interface FakeTabStoreState {
  openSettingsTab: () => void;
  tabs: FakeTab[];
  activeTabId: string | null;
}

const mocks = vi.hoisted(() => {
  const createVoiceState = (): VoiceFixtureState => ({
    status: "error",
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
    mode: "streaming",
    progress: null,
    error:
      "Error invoking remote method 'zcode:voice-dictation': Error: stream-start-503: model-not-loaded",
    startedAt: 1,
    level: 0,
    stable: "",
    tentative: "",
    settingsOpen: false,
  });
  const api = {
    state: createVoiceState(),
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
  const tabState: { tabs: FakeTab[]; activeTabId: string | null } = {
    tabs: [],
    activeTabId: null,
  };
  const settingsTab: FakeTab = { id: "__settings__", kind: "settings" };
  const workspaceTab: FakeTab = { id: "tab-workspace", kind: "workspace" };
  return {
    api,
    settingsTab,
    workspaceTab,
    tabState,
    setVoiceState(patch: Partial<VoiceFixtureState>) {
      api.state = { ...api.state, ...patch };
    },
    resetFixtureState() {
      api.state = createVoiceState();
      tabState.tabs = [];
      tabState.activeTabId = null;
    },
    openSettingsTab: vi.fn(),
    setPending: vi.fn(),
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ voiceDictation: {} }),
  useOptionalPlatform: () => ({ voiceDictation: {} }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: FakeTabStoreState) => unknown) =>
    selector({
      openSettingsTab: mocks.openSettingsTab,
      tabs: mocks.tabState.tabs,
      activeTabId: mocks.tabState.activeTabId,
    }),
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
  mocks.resetFixtureState();
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

describe("voice dictation overlay activity indicator", () => {
  it("hides the activity indicator on the Settings tab while keeping Stop and Cancel", () => {
    mocks.tabState.tabs = [mocks.settingsTab];
    mocks.tabState.activeTabId = mocks.settingsTab.id;
    mocks.setVoiceState({ status: "listening", error: null });

    render(<VoiceDictationOverlay />);

    expect(screen.queryByTestId("voice-dictation-activity")).toBeNull();
    expect(
      screen.getByTestId("voice-dictation-overlay").querySelector(".animate-pulse"),
    ).toBeNull();
    expect(screen.getByText("chat.voice.listening")).toBeTruthy();
    expect(screen.getByText(/Parakeet Unified English/u)).toBeTruthy();
    expect(
      screen.getByTestId("voice-dictation-overlay").querySelector(".tabular-nums"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "chat.voice.openSettings" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "chat.voice.cancel" }));
    expect(mocks.api.cancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "chat.voice.stop" }));
    expect(mocks.api.stop).toHaveBeenCalledTimes(1);
  });

  it("renders the activity indicator when no Settings tab is open", () => {
    mocks.setVoiceState({ status: "listening", error: null });

    render(<VoiceDictationOverlay />);

    const activity = screen.getByTestId("voice-dictation-activity");
    expect(activity.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("keeps the activity indicator when Settings is open but not the active tab", () => {
    mocks.tabState.tabs = [mocks.settingsTab, mocks.workspaceTab];
    mocks.tabState.activeTabId = mocks.workspaceTab.id;
    mocks.setVoiceState({ status: "listening", error: null });

    render(<VoiceDictationOverlay />);

    expect(screen.getByTestId("voice-dictation-activity")).toBeTruthy();
  });
});
