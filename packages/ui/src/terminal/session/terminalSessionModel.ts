import type { IWindowsPty } from "@xterm/xterm";

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
export const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;
export const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
export const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
export const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

export type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TerminalResizeRequestStats = {
  fit: number;
  queued: number;
  sent: number;
  skipped: number;
};

export function normalizeWindowsPtyOption(
  windowsPty: IWindowsPty | undefined,
): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

export function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

export function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

export function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}
