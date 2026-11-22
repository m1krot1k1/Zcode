import { app, ipcMain, session } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { HexVoiceService } from "./hexVoiceService.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommand(
  raw: unknown,
): { ok: true; command: Parameters<HexVoiceService["handle"]>[0] } | { ok: false; error: string } {
  if (!isRecord(raw) || typeof raw.action !== "string") {
    return { ok: false, error: "invalid-voice-command" };
  }
  switch (raw.action) {
    case "status":
    case "stop":
    case "cancel":
      return { ok: true, command: { action: raw.action } };
    case "models":
      return {
        ok: true,
        command: {
          action: "models",
          ...(typeof raw.language === "string" ? { language: raw.language } : {}),
        },
      };
    case "prepare":
      if (
        typeof raw.requestId !== "string" ||
        typeof raw.modelId !== "string" ||
        typeof raw.language !== "string"
      ) {
        return { ok: false, error: "invalid-prepare-request" };
      }
      return {
        ok: true,
        command: {
          action: "prepare",
          requestId: raw.requestId,
          modelId: raw.modelId,
          language: raw.language,
        },
      };
    case "start":
      if (
        !isRecord(raw.request) ||
        typeof raw.request.model !== "string" ||
        typeof raw.request.language !== "string"
      ) {
        return { ok: false, error: "invalid-start-request" };
      }
      return {
        ok: true,
        command: {
          action: "start",
          request: { model: raw.request.model, language: raw.request.language },
        },
      };
    case "appendAudio":
      if (!(raw.samples instanceof ArrayBuffer)) {
        return { ok: false, error: "invalid-audio-chunk" };
      }
      return { ok: true, command: { action: "appendAudio", samples: raw.samples } };
    default:
      return { ok: false, error: "unknown-voice-action" };
  }
}

export function registerVoiceDictationIpc(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}): HexVoiceService {
  const service = new HexVoiceService();
  // The main window uses the default session. Without a request handler,
  // Electron leaves getUserMedia pending forever (the UI would sit in
  // "starting" with no prompt). Media audio is the only permission this layer
  // grants; other requests keep Electron's previous allow behavior.
  // Unit hosts and non-Electron test doubles may not expose `session`/`app`; registration
  // must remain side-effect free there instead of crashing the whole IPC module.
  const defaultSession = session?.defaultSession;
  defaultSession?.setPermissionRequestHandler?.((_contents, permission, callback, details) => {
    if (permission === "media") {
      const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      callback(types.includes("audio"));
      return;
    }
    callback(true);
  });
  ipcMain.handle(PlatformChannels.VoiceDictation, async (event, raw: unknown) => {
    const parsed = parseCommand(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    try {
      return await service.handle(parsed.command, event.sender);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[voice-dictation] command failed", {
        action: parsed.command.action,
        message,
      });
      throw error;
    }
  });
  app?.once?.("before-quit", () => {
    service.dispose();
  });
  return service;
}
