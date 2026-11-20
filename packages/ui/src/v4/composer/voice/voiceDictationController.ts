import type {
  VoiceDictationPort,
  VoiceDictationStartResult,
  VoiceModelPrepareProgress,
  VoiceSpeechModel,
} from "@zcode/shared";
import { getActiveLexicalChatInput } from "@/lexical-chat-input/contract.js";
import { logger } from "@/logger.js";

export type VoiceDictationStatus = "idle" | "starting" | "listening" | "stopping" | "error";

export interface VoiceDictationState {
  readonly status: VoiceDictationStatus;
  readonly available: boolean;
  readonly reason: string | null;
  readonly models: readonly VoiceSpeechModel[];
  readonly modelId: string | null;
  readonly language: string;
  readonly mode: "streaming" | "rolling" | null;
  readonly progress: VoiceModelPrepareProgress | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly level: number;
  readonly stable: string;
  readonly tentative: string;
  readonly settingsOpen: boolean;
}

const MODEL_STORAGE_KEY = "zcode.voice.model";
const LANGUAGE_STORAGE_KEY = "zcode.voice.language";

let state: VoiceDictationState = {
  status: "idle",
  available: false,
  reason: null,
  models: [],
  modelId: null,
  language: typeof navigator === "undefined" ? "en" : navigator.language.slice(0, 2) || "en",
  mode: null,
  progress: null,
  error: null,
  startedAt: null,
  level: 0,
  stable: "",
  tentative: "",
  settingsOpen: false,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<VoiceDictationState>): void {
  state = Object.freeze({ ...state, ...patch });
  for (const listener of listeners) listener();
}

export function subscribeVoiceDictation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVoiceDictationState(): VoiceDictationState {
  return state;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in hardened renderer contexts; the in-memory choice still works.
  }
}

function preferredModel(models: readonly VoiceSpeechModel[], language: string): string | null {
  const stored = readStored(MODEL_STORAGE_KEY);
  if (stored && models.some((model) => model.id === stored)) return stored;
  const installed = models.filter((model) => model.installed);
  const exactLanguage = installed.find((model) => model.languages.includes(language));
  const anyStreaming = installed.find((model) => model.streams);
  return exactLanguage?.id ?? anyStreaming?.id ?? installed[0]?.id ?? models[0]?.id ?? null;
}

function joinTranscript(stable: string, tentative: string): string {
  if (!stable) return tentative;
  if (!tentative) return stable;
  return /[\s\n]$/.test(stable) || /^[\s\n]/.test(tentative)
    ? `${stable}${tentative}`
    : `${stable} ${tentative}`;
}

class VoiceDictationController {
  private port: VoiceDictationPort | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  private configurePromise: Promise<void> | null = null;
  private levelFrame = 0;
  private lastLevelUpdate = 0;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private startToken = 0;

  configure(port: VoiceDictationPort | null): void {
    if (this.port === port) return;
    this.port = port;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    if (!port) {
      setState({ available: false, reason: "unsupported-platform" });
      return;
    }
    this.unsubscribeEvents = port.onEvent((event) => this.handleEvent(event));
    this.configurePromise = this.refresh(false);
  }

  async refresh(loadModels = false): Promise<void> {
    const port = this.port;
    if (!port) return;
    try {
      const status = await port.getStatus();
      setState({
        available: status.available,
        reason: status.reason ?? null,
        error: status.available ? state.error : (status.reason ?? "voice-unavailable"),
      });
      if (!status.available) return;
      if (loadModels || state.models.length === 0) {
        const models = await port.listModels(state.language || undefined);
        const modelId = preferredModel(models, state.language);
        const selected = models.find((model) => model.id === modelId);
        setState({
          models,
          modelId,
          language:
            selected && !selected.languages.includes(state.language)
              ? (selected.languages[0] ?? state.language)
              : state.language,
        });
      }
    } catch (error) {
      setState({
        available: false,
        reason: "engine-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  selectModel(modelId: string): void {
    const model = state.models.find((item) => item.id === modelId);
    writeStored(MODEL_STORAGE_KEY, modelId);
    setState({
      modelId,
      language:
        model && !model.languages.includes(state.language)
          ? (model.languages[0] ?? state.language)
          : state.language,
    });
  }

  selectLanguage(language: string): void {
    writeStored(LANGUAGE_STORAGE_KEY, language);
    setState({ language });
    if (this.port) void this.refresh(true);
  }

  setSettingsOpen(open: boolean): void {
    setState({ settingsOpen: open });
    if (open && this.port && state.models.length === 0) void this.refresh(true);
  }

  async prepareModel(modelId: string, language: string): Promise<void> {
    const port = this.port;
    if (!port) return;
    setState({ progress: null, error: null });
    try {
      await port.prepareModel(modelId, language, (progress) => {
        setState({ progress });
      });
      await this.refresh(true);
      setState({ progress: null });
    } catch (error) {
      setState({
        progress: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async start(): Promise<void> {
    const port = this.port;
    if (!port || (state.status !== "idle" && state.status !== "error")) return;
    const startToken = (this.startToken += 1);
    if (state.models.length === 0 || !state.modelId) {
      await this.refresh(true);
      if (startToken !== this.startToken) return;
    }
    const latest = getVoiceDictationState();
    const modelId = latest.modelId;
    if (!modelId) {
      setState({ error: "voice-model-missing" });
      return;
    }
    const input = getActiveLexicalChatInput();
    if (!input) {
      setState({ error: "voice-input-missing" });
      return;
    }
    setState({
      status: "starting",
      error: null,
      stable: "",
      tentative: "",
      mode: null,
      level: 0,
    });
    try {
      const result: VoiceDictationStartResult = await port.start({
        model: modelId,
        language: latest.language,
      });
      if (startToken !== this.startToken) {
        await port.cancel().catch(() => undefined);
        return;
      }
      input.beginVoiceDictation();
      await this.openMicrophone();
      if (startToken !== this.startToken) {
        this.cleanupAudio();
        await port.cancel().catch(() => undefined);
        return;
      }
      setState({
        status: "listening",
        mode: result.mode,
        startedAt: Date.now(),
      });
    } catch (error) {
      await port.cancel().catch(() => undefined);
      this.cleanupAudio();
      setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async openMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("voice-microphone-unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    this.source = source;
    const processor = context.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    const ratio = context.sampleRate / 16_000;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const outputLength = Math.max(1, Math.floor(input.length / ratio));
      const pcm = new Int16Array(outputLength);
      let energy = 0;
      for (let index = 0; index < outputLength; index += 1) {
        const position = index * ratio;
        const lower = Math.floor(position);
        const upper = Math.min(input.length - 1, lower + 1);
        const fraction = position - lower;
        const sample = (input[lower] ?? 0) * (1 - fraction) + (input[upper] ?? 0) * fraction;
        const clamped = Math.max(-1, Math.min(1, sample));
        pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        energy += clamped * clamped;
      }
      const now = performance.now();
      if (now - this.lastLevelUpdate > 80) {
        this.lastLevelUpdate = now;
        setState({ level: Math.min(1, Math.sqrt(energy / outputLength) * 4) });
      }
      const port = this.port;
      if (!port) return;
      this.appendChain = this.appendChain
        .then(() => port.appendAudio(pcm.buffer))
        .catch((error) => {
          logger.warn("[voice-dictation] appendAudio failed", error);
        });
    };
    source.connect(processor);
    processor.connect(context.destination);
  }

  async stop(): Promise<void> {
    const port = this.port;
    if (!port || state.status !== "listening") return;
    setState({ status: "stopping", level: 0 });
    this.stopCapture();
    this.finalizeTimer = setTimeout(() => {
      this.finalize("");
    }, 6_000);
    try {
      await port.stop();
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : String(error) });
      this.finalize("");
    }
  }

  async cancel(): Promise<void> {
    this.startToken += 1;
    const port = this.port;
    const input = getActiveLexicalChatInput();
    input?.cancelVoiceDictation();
    this.stopCapture();
    setState({ status: "idle", stable: "", tentative: "", mode: null, level: 0 });
    await port?.cancel().catch(() => undefined);
    this.clearFinalizeTimer();
  }

  private stopCapture(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    cancelAnimationFrame(this.levelFrame);
  }

  private cleanupAudio(): void {
    this.stopCapture();
    this.appendChain = Promise.resolve();
  }

  private clearFinalizeTimer(): void {
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = null;
  }

  private finalize(text: string): void {
    this.clearFinalizeTimer();
    this.cleanupAudio();
    const input = getActiveLexicalChatInput();
    if (text) input?.applyVoiceDictation(text, true);
    setState({ status: "idle", stable: "", tentative: "", mode: null, level: 0 });
  }

  private handleEvent(event: import("@zcode/shared").VoiceDictationEvent): void {
    if (event.type === "partial") {
      setState({ stable: event.stable, tentative: event.tentative });
      const input = getActiveLexicalChatInput();
      input?.applyVoiceDictation(joinTranscript(event.stable, event.tentative));
      return;
    }
    if (event.type === "final") {
      this.finalize(event.text);
      return;
    }
    if (event.type === "error") {
      this.cleanupAudio();
      setState({
        status: "error",
        error: event.message || event.code,
        mode: null,
        level: 0,
      });
      return;
    }
    if (event.type === "ready") {
      setState({ mode: event.mode, status: "listening", startedAt: Date.now() });
    }
  }
}

const controller = new VoiceDictationController();

export function useVoiceDictationController(): VoiceDictationController {
  return controller;
}

export function getVoiceDictationController(): VoiceDictationController {
  return controller;
}
