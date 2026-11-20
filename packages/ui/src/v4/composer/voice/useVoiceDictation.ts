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
  setSettingsOpen(open: boolean): void;
}

/**
 * In-app dictation shortcut: hold to talk, or tap twice to keep recording.
 * The listener runs only while a ZCode window has focus; the global toggle is
 * intentionally not registered here.
 */
function useVoiceDictationHotkey(api: VoiceDictationApi): void {
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handsFree = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    const clearStopTimer = () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      stopTimer.current = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const current = apiRef.current;
      if (event.repeat) return;
      if (current.state.status === "listening") {
        if (stopTimer.current) {
          // Second tap: cancel the deferred stop and stay recording hands-free.
          clearStopTimer();
          handsFree.current = true;
          return;
        }
        if (handsFree.current) {
          handsFree.current = false;
          void current.stop();
        }
        return;
      }
      if (current.state.status === "starting" || current.state.status === "stopping") return;
      handsFree.current = false;
      void current.start();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const current = apiRef.current;
      if (current.state.status !== "listening" || handsFree.current) return;
      clearStopTimer();
      stopTimer.current = setTimeout(() => {
        stopTimer.current = null;
        if (apiRef.current.state.status === "listening") {
          void apiRef.current.stop();
        }
      }, 350);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      clearStopTimer();
    };
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
    setSettingsOpen: (open) => controller.setSettingsOpen(open),
  };
  useVoiceDictationHotkey(api);
  return api;
}
