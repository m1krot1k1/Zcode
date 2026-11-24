// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictationPort, VoiceSpeechModel } from "@zcode/shared";
import { getVoiceDictationController, getVoiceDictationState } from "./voiceDictationController.js";

const installedModel: VoiceSpeechModel = {
  id: "parakeet_unified_en",
  name: "Parakeet Unified English",
  languages: ["en"],
  installed: true,
  verified: true,
  downloadBytes: 1,
  streams: true,
};

function createPort(): VoiceDictationPort {
  return {
    getStatus: vi.fn(async () => ({ available: true, running: false })),
    listModels: vi.fn(async () => [installedModel]),
    prepareModel: vi.fn(async () => {}),
    start: vi.fn(async () => ({
      mode: "streaming" as const,
      model: installedModel.id,
      language: "en",
      partials: true,
    })),
    appendAudio: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("voice dictation pre-setup", () => {
  it("does not treat an auto-selected model as a finished setup", async () => {
    const controller = getVoiceDictationController();
    controller.configure(createPort());
    await controller.refresh(true);

    expect(getVoiceDictationState().modelId).toBe(installedModel.id);
    expect(getVoiceDictationState().configured).toBe(false);
  });

  it("completes the setup when the user picks an installed model", async () => {
    const controller = getVoiceDictationController();
    controller.configure(createPort());
    await controller.refresh(true);

    controller.selectModel(installedModel.id);

    expect(getVoiceDictationState().configured).toBe(true);
  });

  it("opens the setup instead of dictating when the setup is missing", async () => {
    const port = createPort();
    const controller = getVoiceDictationController();
    controller.configure(port);
    await controller.refresh(true);

    await controller.start();

    expect(port.start).not.toHaveBeenCalled();
    expect(getVoiceDictationState().settingsOpen).toBe(true);
  });

  it("reports the engine as unavailable instead of dictating", async () => {
    const port = createPort();
    port.getStatus = vi.fn(async () => ({
      available: false,
      reason: "binary-missing" as const,
      running: false,
    }));
    const controller = getVoiceDictationController();
    controller.configure(port);
    await controller.refresh(true);

    await controller.start();

    expect(port.start).not.toHaveBeenCalled();
    expect(getVoiceDictationState().settingsOpen).toBe(true);
  });

  it("offers the languages of the whole catalog, not only of one model", async () => {
    const port = createPort();
    port.listModels = vi.fn(async (language?: string) =>
      language
        ? [installedModel]
        : [installedModel, { ...installedModel, id: "gigaam_ru", languages: ["ru", "en"] }],
    );
    const controller = getVoiceDictationController();
    controller.configure(port);
    await controller.refresh(true);

    expect(getVoiceDictationState().languages).toEqual(["en", "ru"]);
  });

  it("stores a new shortcut and keeps it in the state", () => {
    const controller = getVoiceDictationController();

    controller.setShortcut("Control+Shift+Space");

    expect(getVoiceDictationState().shortcut).toBe("Control+Shift+Space");
    expect(window.localStorage.getItem("zcode.voice.shortcut")).toBe("Control+Shift+Space");

    controller.setShortcut("Alt");
  });
});
