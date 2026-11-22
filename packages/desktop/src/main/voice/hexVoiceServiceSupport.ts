/**
 * Hex service transport helpers, kept separate to preserve the 800-line policy on
 * `hexVoiceService.ts` (the class owns lifecycle; this module owns framing).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { VoiceDictationStartRequest } from "@zcode/shared";

export const SAMPLE_RATE = 16_000;
export const READY_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const ROLLING_TICK_MS = 700;
export const ROLLING_MIN_SAMPLES = SAMPLE_RATE * 1.2;
export const ROLLING_MAX_SAMPLES = SAMPLE_RATE * 15;
export const SILENCE_RMS = 0.008;
export const SILENCE_COMMIT_MS = 650;
export const HEARTBEAT_MS = 4_000;
export const PREPARE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const LOADED_MODEL_TIMEOUT_MS = 60_000;
export const STREAM_START_RETRY_MS = 300;
export const STREAM_START_RETRIES = 40;

export type VoiceCommand =
  | { readonly action: "status" }
  | { readonly action: "models"; readonly language?: string }
  | {
      readonly action: "prepare";
      readonly requestId: string;
      readonly modelId: string;
      readonly language: string;
    }
  | { readonly action: "start"; readonly request: VoiceDictationStartRequest }
  | { readonly action: "appendAudio"; readonly samples: ArrayBuffer }
  | { readonly action: "stop" }
  | { readonly action: "cancel" };

export interface EngineEndpoint {
  readonly url: string;
  readonly token: string;
  readonly version?: string;
}

export interface StreamingSession {
  readonly mode: "streaming";
  readonly id: number;
  readonly ownerToken: string;
  readonly model: string;
  readonly language: string;
  readonly abort: AbortController;
  readonly heartbeat: ReturnType<typeof setInterval>;
}

export interface RollingSession {
  readonly mode: "rolling";
  readonly model: string;
  readonly language: string;
  samples: Int16Array[];
  committedText: string;
  tentativeText: string;
  silentMs: number;
  lastTickAt: number;
  busy: boolean;
  finishing: boolean;
}

export type Session = StreamingSession | RollingSession;

function binaryName(): string {
  return process.platform === "win32" ? "hex-service.exe" : "hex-service";
}

export function resolveEngineBinary(): string {
  const override = process.env.ZCODE_HEX_SERVICE_PATH?.trim();
  if (override && existsSync(override)) return override;
  const name = binaryName();
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "voice", name)]
    : [
        join(process.cwd(), "bundled-voice", `${process.platform}-${process.arch}`, name),
        join(app.getAppPath(), "bundled-voice", `${process.platform}-${process.arch}`, name),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function platformSupported(): boolean {
  return (
    process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
  );
}

export function toWav(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(samples.buffer, samples.byteOffset, dataBytes));
  return new Uint8Array(buffer);
}

export async function readSse(
  response: Response,
  onData: (payload: unknown) => boolean | void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          const stop = onData(JSON.parse(data));
          if (stop === false) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        } catch {
          // A malformed provider event must not tear down the dictation stream.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel().catch(() => undefined);
}

export function int16FromArrayBuffer(buffer: ArrayBuffer): Int16Array {
  if (buffer.byteLength % 2 !== 0) {
    return new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  }
  return new Int16Array(buffer);
}
