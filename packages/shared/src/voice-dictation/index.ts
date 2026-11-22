/**
 * Local voice dictation (Hex engine) — platform-facing types.
 *
 * The Desktop main process owns the `hex-service` child, the loopback token,
 * model downloads, and audio streaming. The renderer only sees bounded status,
 * catalog, progress, and transcript events.
 */

export type VoiceDictationAvailabilityReason =
  | "binary-missing"
  | "unsupported-platform"
  | "engine-failed"
  | "permission-denied";

export interface VoiceDictationStatus {
  readonly available: boolean;
  readonly reason?: VoiceDictationAvailabilityReason;
  readonly engineVersion?: string;
  readonly running: boolean;
}

export interface VoiceSpeechModel {
  readonly id: string;
  readonly name: string;
  readonly languages: readonly string[];
  readonly installed: boolean;
  readonly verified: boolean;
  readonly downloadBytes: number | null;
  /** Canonical Hex streaming capability; only streaming models emit partial events. */
  readonly streams: boolean;
}

export type VoiceModelPrepareStage = "downloading" | "loading" | "ok" | "error";

export interface VoiceModelPrepareProgress {
  readonly modelId: string;
  readonly stage: VoiceModelPrepareStage;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly code?: string;
  readonly message?: string;
}

export interface VoiceDictationStartRequest {
  readonly model: string;
  readonly language: string;
}

export type VoiceDictationMode = "streaming" | "rolling";

export interface VoiceDictationStartResult {
  readonly mode: VoiceDictationMode;
  readonly model: string;
  readonly language: string;
  readonly partials: boolean;
}

export type VoiceDictationEvent =
  | {
      readonly type: "ready";
      readonly mode: VoiceDictationMode;
      readonly model: string;
      readonly language: string;
      readonly partials: boolean;
    }
  | {
      readonly type: "partial";
      readonly stable: string;
      readonly tentative: string;
    }
  | {
      readonly type: "final";
      readonly text: string;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "prepare-progress";
      readonly requestId: string;
      readonly progress: VoiceModelPrepareProgress;
    };

export interface VoiceDictationPort {
  getStatus(): Promise<VoiceDictationStatus>;
  listModels(language?: string): Promise<VoiceSpeechModel[]>;
  prepareModel(
    modelId: string,
    language: string,
    onProgress: (progress: VoiceModelPrepareProgress) => void,
  ): Promise<void>;
  start(request: VoiceDictationStartRequest): Promise<VoiceDictationStartResult>;
  appendAudio(samples: ArrayBuffer): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  onEvent(listener: (event: VoiceDictationEvent) => void): () => void;
}
