/**
 * Desktop main-process owner of the bundled Hex speech engine.
 *
 * Hex prints one ready line with a loopback URL and a bearer token on stdout.
 * The token never leaves main. The renderer only sends 16 kHz mono s16le chunks
 * and receives bounded transcript events.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { BrowserWindow, type WebContents } from "electron";
import {
  PlatformChannels,
  type VoiceDictationEvent,
  type VoiceDictationStartRequest,
  type VoiceDictationStartResult,
  type VoiceDictationStatus,
  type VoiceModelPrepareProgress,
  type VoiceSpeechModel,
} from "@zcode/shared";

import {
  HEARTBEAT_MS,
  LOADED_MODEL_TIMEOUT_MS,
  PREPARE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  ROLLING_MAX_SAMPLES,
  ROLLING_MIN_SAMPLES,
  ROLLING_TICK_MS,
  SAMPLE_RATE,
  SILENCE_COMMIT_MS,
  SILENCE_RMS,
  STREAM_START_RETRIES,
  STREAM_START_RETRY_MS,
  int16FromArrayBuffer,
  platformSupported,
  readSse,
  resolveEngineBinary,
  toWav,
  type EngineEndpoint,
  type RollingSession,
  type Session,
  type StreamingSession,
  type VoiceCommand,
} from "./hexVoiceServiceSupport.js";

export class HexVoiceService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private endpoint: EngineEndpoint | null = null;
  private starting: Promise<EngineEndpoint> | null = null;
  private stderrTail: string[] = [];
  private session: Session | null = null;
  private startError: string | null = null;
  private loadedModelId: string | null = null;
  private readonly models = new Map<string, VoiceSpeechModel>();
  private disposed = false;

  async getStatus(): Promise<VoiceDictationStatus> {
    if (!platformSupported()) {
      return { available: false, reason: "unsupported-platform", running: false };
    }
    if (!existsSync(resolveEngineBinary())) {
      return { available: false, reason: "binary-missing", running: false };
    }
    if (this.startError) {
      // Keep the entry visible so the user can retry after a transient crash;
      // ensureEngine resets this marker on the next start.
      return { available: true, reason: "engine-failed", running: false };
    }
    return {
      available: true,
      running: this.endpoint !== null,
      ...(this.endpoint?.version ? { engineVersion: this.endpoint.version } : {}),
    };
  }

  async handle(command: VoiceCommand, sender?: WebContents): Promise<unknown> {
    switch (command.action) {
      case "status":
        return this.getStatus();
      case "models":
        return this.listModels(command.language);
      case "prepare":
        return this.prepareModel(command.requestId, command.modelId, command.language, sender);
      case "start":
        return this.start(command.request);
      case "appendAudio":
        return this.appendAudio(command.samples);
      case "stop":
        return this.stop();
      case "cancel":
        return this.cancel();
    }
  }

  private emit(event: VoiceDictationEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PlatformChannels.VoiceDictationEvent, event);
      }
    }
  }

  private async ensureEngine(): Promise<EngineEndpoint> {
    if (this.endpoint) return this.endpoint;
    if (this.starting) return this.starting;
    if (this.disposed) throw new Error("voice-service-disposed");
    const binary = resolveEngineBinary();
    if (!existsSync(binary)) throw new Error("engine-binary-missing");
    this.startError = null;
    this.starting = new Promise<EngineEndpoint>((resolve, reject) => {
      const child = spawn(binary, ["service", "--embedded"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      this.child = child;
      this.stderrTail = [];
      const timer = setTimeout(() => {
        reject(new Error("engine-ready-timeout"));
        child.kill();
      }, READY_TIMEOUT_MS);
      let buffer = "";
      const finish = (endpoint: EngineEndpoint) => {
        clearTimeout(timer);
        this.endpoint = endpoint;
        resolve(endpoint);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line) as {
                type?: string;
                url?: string;
                token?: string;
                apiVersion?: string;
              };
              if (parsed.type === "ready" && parsed.url && parsed.token) {
                finish({
                  url: parsed.url.replace(/\/+$/, ""),
                  token: parsed.token,
                  ...(parsed.apiVersion ? { version: parsed.apiVersion } : {}),
                });
              }
            } catch {
              // Rust logs may contain braces; only the ready line is JSON.
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          this.stderrTail.push(line.trim());
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        this.startError = error.message;
        this.child = null;
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        this.endpoint = null;
        this.child = null;
        this.session = null;
        this.loadedModelId = null;
        if (!this.disposed && code !== 0) {
          this.startError = `engine-exited-${code ?? "unknown"}`;
          this.emit({
            type: "error",
            code: "engine-exited",
            message: this.stderrTail.at(-1) ?? `hex-service exited with ${code}`,
          });
        }
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async request(
    endpoint: EngineEndpoint,
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${endpoint.token}`);
    return fetch(`${endpoint.url}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  async listModels(language?: string): Promise<VoiceSpeechModel[]> {
    const endpoint = await this.ensureEngine();
    const suffix = language ? `?language=${encodeURIComponent(language)}` : "";
    const response = await this.request(endpoint, `/models${suffix}`);
    if (!response.ok) throw new Error(`voice-models-${response.status}`);
    const rows = (await response.json()) as Array<{
      id: string;
      name: string;
      installed: boolean;
      verified: boolean;
      downloadBytes?: number | null;
      languages?: string[];
      streams?: boolean;
    }>;
    this.models.clear();
    const models = rows.map((row) => {
      const model: VoiceSpeechModel = Object.freeze({
        id: row.id,
        name: row.name,
        languages: Object.freeze([...(row.languages ?? [])]),
        installed: row.installed,
        verified: row.verified,
        downloadBytes: row.downloadBytes ?? null,
        streams: row.streams === true,
      });
      this.models.set(model.id, model);
      return model;
    });
    return models;
  }

  /**
   * Consumes Hex's prepare SSE. The stream closes with `type:"ok"` after the
   * model is downloaded/verified, but the shared engine may still be swapping it
   * in; `startStream` retries `/streams` until that swap is observable.
   */
  private async runModelPrepare(
    endpoint: EngineEndpoint,
    modelId: string,
    language: string,
    onProgress?: (progress: VoiceModelPrepareProgress) => void,
    timeoutMs = PREPARE_TIMEOUT_MS,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.request(
        endpoint,
        `/models/${encodeURIComponent(modelId)}/prepare?language=${encodeURIComponent(language)}`,
        { method: "POST" },
        timeoutMs,
      );
    } catch (error) {
      throw new Error(
        `model-load-failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      const progress: VoiceModelPrepareProgress = {
        modelId,
        stage: "error",
        downloadedBytes: 0,
        totalBytes: this.models.get(modelId)?.downloadBytes ?? 0,
        code: `prepare-${response.status}`,
        message: message.slice(0, 500),
      };
      onProgress?.(progress);
      throw new Error(progress.code);
    }
    let failure: string | null = null;
    await readSse(response, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const data = payload as {
        type?: string;
        downloadedBytes?: number;
        totalBytes?: number;
        code?: string;
        message?: string;
      };
      const stage =
        data.type === "ok"
          ? "ok"
          : data.type === "loading"
            ? "loading"
            : data.type === "error"
              ? "error"
              : "downloading";
      const progress: VoiceModelPrepareProgress = {
        modelId,
        stage,
        downloadedBytes: data.downloadedBytes ?? 0,
        totalBytes: data.totalBytes ?? this.models.get(modelId)?.downloadBytes ?? 0,
        ...(data.code ? { code: data.code } : {}),
        ...(data.message ? { message: data.message } : {}),
      };
      onProgress?.(progress);
      if (stage === "error") {
        failure = data.message || data.code || "model-load-failed";
        return false;
      }
      return stage === "ok" ? false : undefined;
    });
    if (failure) throw new Error(failure);
  }

  private async prepareModel(
    requestId: string,
    modelId: string,
    language: string,
    sender?: WebContents,
  ): Promise<void> {
    const endpoint = await this.ensureEngine();
    const sendProgress = (progress: VoiceModelPrepareProgress) => {
      if (sender && !sender.isDestroyed()) {
        sender.send(PlatformChannels.VoiceDictationEvent, {
          type: "prepare-progress",
          requestId,
          progress,
        } satisfies VoiceDictationEvent);
      }
    };
    await this.runModelPrepare(endpoint, modelId, language, sendProgress);
    this.loadedModelId = modelId;
    // Refresh installed state for the UI after a successful download.
    void this.listModels(language).catch(() => undefined);
  }

  /**
   * Starts a streaming session only after the installed model is loaded.
   *
   * Root cause of `stream-start-503`: Hex's shared engine reports `ok` before the
   * asynchronous model swap finishes; the old code posted `/streams` immediately
   * and never prepared an installed model at all. We prepare once and retry the
   * bounded 503/model-not-loaded window instead of surfacing a raw IPC error.
   */
  private async startStream(
    endpoint: EngineEndpoint,
    request: VoiceDictationStartRequest,
  ): Promise<Response> {
    const body = JSON.stringify({
      sampleFormat: "s16le",
      sampleRate: SAMPLE_RATE,
      model: request.model,
      language: request.language,
    });
    let prepared = this.loadedModelId === request.model;
    for (let attempt = 0; attempt < STREAM_START_RETRIES; attempt += 1) {
      if (!prepared) {
        const model = this.models.get(request.model);
        if (!model || !model.installed) throw new Error("model-not-installed");
        await this.runModelPrepare(
          endpoint,
          request.model,
          request.language,
          undefined,
          LOADED_MODEL_TIMEOUT_MS,
        );
        prepared = true;
        continue;
      }
      const response = await this.request(endpoint, "/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (response.ok) {
        this.loadedModelId = request.model;
        return response;
      }
      const text = await response.text().catch(() => "");
      if (response.status === 503 && text.includes("model-not-loaded")) {
        // The engine accepted prepare but is still swapping the model. A 503 on
        // an already-loaded model means it was unloaded; force one fresh prepare.
        if (attempt === 0) prepared = false;
        await new Promise((resolve) => setTimeout(resolve, STREAM_START_RETRY_MS));
        continue;
      }
      throw new Error(`stream-start-${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    throw new Error("stream-start-503: model-not-loaded");
  }

  private async start(request: VoiceDictationStartRequest): Promise<VoiceDictationStartResult> {
    if (this.session) throw new Error("dictation-already-active");
    const endpoint = await this.ensureEngine();
    let model = this.models.get(request.model);
    if (!model) {
      const models = await this.listModels(request.language);
      model = models.find((item) => item.id === request.model);
    }
    if (!model) throw new Error("unknown-model");
    if (!model.installed) throw new Error("model-not-installed");

    if (model.streams) {
      const response = await this.startStream(endpoint, request);
      const created = (await response.json()) as {
        id: number;
        ownerToken: string;
        partials: boolean;
      };
      const abort = new AbortController();
      const heartbeat = setInterval(() => {
        void this.request(
          endpoint,
          `/streams/${created.id}/heartbeat`,
          { method: "POST", headers: { "X-Hex-Stream-Token": created.ownerToken } },
          5_000,
        ).catch(() => undefined);
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      const session: StreamingSession = {
        mode: "streaming",
        id: created.id,
        ownerToken: created.ownerToken,
        model: request.model,
        language: request.language,
        abort,
        heartbeat,
      };
      this.session = session;
      void this.consumeStream(endpoint, session);
      const result: VoiceDictationStartResult = {
        mode: "streaming",
        model: request.model,
        language: request.language,
        partials: created.partials,
      };
      this.emit({ type: "ready", ...result });
      return result;
    }

    const session: RollingSession = {
      mode: "rolling",
      model: request.model,
      language: request.language,
      samples: [],
      committedText: "",
      tentativeText: "",
      silentMs: 0,
      lastTickAt: 0,
      busy: false,
      finishing: false,
    };
    // Non-streaming models are transcribed lazily per window, but loading the
    // installed model now avoids a slow/failed first window and matches the
    // streaming path's readiness contract.
    if (this.loadedModelId !== request.model) {
      await this.runModelPrepare(
        endpoint,
        request.model,
        request.language,
        undefined,
        LOADED_MODEL_TIMEOUT_MS,
      );
      this.loadedModelId = request.model;
    }
    this.session = session;
    const result: VoiceDictationStartResult = {
      mode: "rolling",
      model: request.model,
      language: request.language,
      partials: false,
    };
    this.emit({ type: "ready", ...result });
    return result;
  }

  private async consumeStream(endpoint: EngineEndpoint, session: StreamingSession): Promise<void> {
    try {
      const response = await this.request(
        endpoint,
        `/streams/${session.id}/events`,
        {
          headers: { "X-Hex-Stream-Token": session.ownerToken },
          signal: session.abort.signal,
        },
        120_000,
      );
      if (!response.ok) throw new Error(`stream-events-${response.status}`);
      await readSse(
        response,
        (payload) => {
          if (typeof payload !== "object" || payload === null) return;
          const data = payload as {
            type?: string;
            stable?: string;
            tentative?: string;
            text?: string;
            code?: string;
            message?: string;
          };
          if (data.type === "partial") {
            this.emit({
              type: "partial",
              stable: data.stable ?? "",
              tentative: data.tentative ?? "",
            });
          } else if (data.type === "segment" && data.text) {
            this.emit({ type: "partial", stable: data.text, tentative: "" });
          } else if (data.type === "final") {
            this.emit({ type: "final", text: data.text ?? "" });
          } else if (data.type === "error") {
            this.emit({
              type: "error",
              code: data.code ?? "stream-error",
              message: data.message ?? "",
            });
          }
        },
        session.abort.signal,
      );
    } catch (error) {
      if (!session.abort.signal.aborted) {
        this.emit({
          type: "error",
          code: "stream-events-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async appendAudio(buffer: ArrayBuffer): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.mode === "streaming") {
      const endpoint = await this.ensureEngine();
      const response = await this.request(
        endpoint,
        `/streams/${session.id}/audio`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Hex-Stream-Token": session.ownerToken,
          },
          body: buffer,
        },
        10_000,
      );
      if (!response.ok) {
        this.emit({
          type: "error",
          code: `stream-audio-${response.status}`,
          message: "Audio chunk was rejected.",
        });
      }
      return;
    }
    const samples = int16FromArrayBuffer(buffer);
    if (samples.length === 0) return;
    session.samples.push(samples);
    let total = 0;
    for (const chunk of session.samples) total += chunk.length;
    while (total > ROLLING_MAX_SAMPLES && session.samples.length > 1) {
      total -= session.samples.shift()!.length;
    }
    let energy = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const value = (samples[index] ?? 0) / 32768;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / samples.length);
    session.silentMs =
      rms < SILENCE_RMS ? session.silentMs + (samples.length / SAMPLE_RATE) * 1000 : 0;
    if (total < ROLLING_MIN_SAMPLES || session.busy || session.finishing) return;
    const now = Date.now();
    if (now - session.lastTickAt < ROLLING_TICK_MS) return;
    session.lastTickAt = now;
    void this.tickRolling(session, false);
  }

  private rollingSamples(session: RollingSession): Int16Array {
    let total = 0;
    for (const chunk of session.samples) total += chunk.length;
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of session.samples) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  private async transcribe(endpoint: EngineEndpoint, session: RollingSession, samples: Int16Array) {
    const response = await this.request(
      endpoint,
      `/transcriptions?model=${encodeURIComponent(session.model)}&language=${encodeURIComponent(session.language)}`,
      {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: toWav(samples),
      },
      60_000,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`transcribe-${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    const data = (await response.json()) as { transcript?: string };
    return data.transcript?.trim() ?? "";
  }

  private async tickRolling(session: RollingSession, finishing: boolean): Promise<void> {
    if (session.busy || session !== this.session) return;
    session.busy = true;
    try {
      const endpoint = await this.ensureEngine();
      const text = await this.transcribe(endpoint, session, this.rollingSamples(session));
      if (session !== this.session) return;
      if (text) {
        session.tentativeText = text;
        this.emit({
          type: "partial",
          stable: session.committedText,
          tentative: text,
        });
      }
      if (!finishing && session.silentMs >= SILENCE_COMMIT_MS && text) {
        session.committedText = `${session.committedText} ${text}`.trim();
        session.samples = [];
        session.tentativeText = "";
        session.silentMs = 0;
        this.emit({ type: "partial", stable: session.committedText, tentative: "" });
      }
    } catch (error) {
      // A failed rolling window keeps the previous text; the next tick retries.
      console.warn("[voice-dictation] rolling window failed", error);
    } finally {
      session.busy = false;
    }
  }

  private clearSession(): Session | null {
    const session = this.session;
    this.session = null;
    if (session?.mode === "streaming") {
      clearInterval(session.heartbeat);
      session.abort.abort();
    }
    return session;
  }

  private async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.mode === "streaming") {
      const endpoint = await this.ensureEngine();
      this.clearSession();
      try {
        const response = await this.request(
          endpoint,
          `/streams/${session.id}/finish`,
          {
            method: "POST",
            headers: { "X-Hex-Stream-Token": session.ownerToken },
          },
          130_000,
        );
        if (response.ok) {
          const data = (await response.json()) as { text?: string };
          this.emit({ type: "final", text: data.text ?? "" });
        }
      } catch {
        // The events channel may already have delivered the final; nothing else to do.
      }
      return;
    }
    session.finishing = true;
    try {
      if (session.samples.length > 0) {
        await this.tickRolling(session, true);
      }
      const finalText = `${session.committedText} ${session.tentativeText}`.trim();
      this.clearSession();
      this.emit({ type: "final", text: finalText });
    } finally {
      this.clearSession();
    }
  }

  private async cancel(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.mode === "streaming") {
      const endpoint = await this.ensureEngine();
      this.clearSession();
      await this.request(
        endpoint,
        `/streams/${session.id}/cancel`,
        {
          method: "POST",
          headers: { "X-Hex-Stream-Token": session.ownerToken },
        },
        5_000,
      ).catch(() => undefined);
      return;
    }
    this.clearSession();
  }

  dispose(): void {
    this.disposed = true;
    this.loadedModelId = null;
    this.clearSession();
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.endpoint = null;
  }
}
