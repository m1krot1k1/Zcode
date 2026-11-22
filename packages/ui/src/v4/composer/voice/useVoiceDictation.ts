import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  getVoiceDictationController,
  getVoiceDictationState,
  subscribeVoiceDictation,
  type VoiceDictationState,
} from "./voiceDictationController.js";

export interface VoiceDictationApi {
  readonly state: VoiceDictationState;
  readonly supported: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  selectModel(modelId: string): void;
  selectLanguage(language: string): void;
  prepareModel(modelId: string, language: string): Promise<void>;
  refreshModels(): Promise<void>;
  setSettingsOpen(open: boolean): void;
}

/**
 * In-app dictation shortcut: hold Option to talk, or tap twice to keep recording.
 * Listeners are installed once per renderer; every mounted Composer updates the
 * single active API reference instead of registering another keydown pair.
 */
let activeDictationApi: VoiceDictationApi | null = null;
let hotkeyInstalled = false;

function installVoiceDictationHotkey(): void {
  if (hotkeyInstalled || typeof window === "undefined") return;
  hotkeyInstalled = true;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let handsFree = false;
  const clearStopTimer = () => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  };
  const isDictationKey = (event: KeyboardEvent) =>
    (event.code === "AltLeft" || event.code === "AltRight") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isDictationKey(event)) return;
    const current = activeDictationApi;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (current.state.status === "listening") {
      if (stopTimer) {
        // Second tap: cancel the deferred stop and stay recording hands-free.
        clearStopTimer();
        handsFree = true;
        return;
      }
      handsFree = false;
      void current.stop();
      return;
    }
    if (current.state.status === "starting") {
      if (stopTimer) {
        clearStopTimer();
        handsFree = true;
      }
      return;
    }
    if (current.state.status === "stopping") return;
    handsFree = false;
    void current.start();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!isDictationKey(event)) return;
    const current = activeDictationApi;
    if (!current || handsFree) return;
    if (current.state.status === "idle" || current.state.status === "stopping") return;
    clearStopTimer();
    stopTimer = setTimeout(() => {
      stopTimer = null;
      const status = activeDictationApi?.state.status;
      if (status === "listening") {
        void activeDictationApi?.stop();
      } else if (status === "starting") {
        void activeDictationApi?.cancel();
      }
    }, 350);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
}

function useVoiceDictationHotkey(api: VoiceDictationApi): void {
  activeDictationApi = api;
  useEffect(() => {
    installVoiceDictationHotkey();
  }, []);
}

export function useVoiceDictation(): VoiceDictationApi {
  const platform = usePlatform();
  const port = platform.voiceDictation ?? null;
  const state = useSyncExternalStore(subscribeVoiceDictation, getVoiceDictationState);
  const controller = getVoiceDictationController();

  useEffect(() => {
    controller.configure(port);
  }, [controller, port]);

  const api: VoiceDictationApi = {
    state,
    supported: port !== null && state.available,
    start: () => controller.start(),
    stop: () => controller.stop(),
    cancel: () => controller.cancel(),
    selectModel: (modelId) => controller.selectModel(modelId),
    selectLanguage: (language) => controller.selectLanguage(language),
    prepareModel: (modelId, language) => controller.prepareModel(modelId, language),
    refreshModels: () => controller.refresh(true),
    setSettingsOpen: (open) => controller.setSettingsOpen(open),
  };
  useVoiceDictationHotkey(api);
  return api;
}
