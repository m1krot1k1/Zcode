// ============================================================
// Node FileSystem Adapter
// ============================================================





import { Worker } from "node:worker_threads";
import type { RgArg, RipgrepBufferedResult } from "ripgrep";
import { type FileSystemSearchTextEntry, type FileSystemTextSearchOutputMode, type FileSystemSearchTextRequest } from "@zcode/contracts";


import { WALK_EXCLUDED_DIRECTORIES } from "./walk-files.js";


// Общая основа файлового поиска: типы, константы, runtime-оверрайды,
// glob-матчинг и сборка only-matching результатов. Вынесено из fs/index.ts.



export const DEFAULT_GLOB_MAX_RESULTS = 100;


export const DEFAULT_GREP_HEAD_LIMIT = 250;


export const DEFAULT_RIPGREP_TIMEOUT_MS = 30_000;


/**
 * Каталоги, исключаемые из ripgrep-поиска.
 *
 * Тот же набор использует `walkFiles`; здесь он нужен для `--glob`-аргументов ripgrep.
 * Замер на этом репозитории: обход без `node_modules` 0.27 с, с ним 8.18 с — ровно те
 * секунды, которые Glob проводил на каждый вызов.
 */
export const VCS_DIRECTORIES_TO_EXCLUDE = WALK_EXCLUDED_DIRECTORIES;



export type RipgrepWorker = Pick<Worker, "once" | "terminate">;



export interface RipgrepWorkerData {
  args: string[];
  preopens: Record<string, string>;
}



export interface SerializedWorkerError {
  code?: unknown;
  message?: string;
  name?: string;
  stack?: string;
}



export type RipgrepWorkerMessage =
  | { type: "result"; result: RipgrepBufferedResult }
  | { type: "error"; error: SerializedWorkerError };



export type RipgrepWorkerFactory = (workerData: RipgrepWorkerData) => RipgrepWorker;



export const RIPGREP_WORKER_SOURCE = `
export const { parentPort, workerData } = require("node:worker_threads");

export function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Error" };
  }
  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

(async () => {
  try {
    const { ripgrep } = await import("ripgrep");
    const result = await ripgrep(workerData.args, {
      buffer: true,
      env: {},
      nodeWasi: false,
      preopens: workerData.preopens,
      returnOnExit: true,
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) });
  }
})();
`;



export interface FileSearchCandidate {
  path: string;
  mtimeMs: number;
}



export interface TextSearchResult {
  matchCount: number;
  entries: FileSystemSearchTextEntry[];
}



export interface LineRange {
  start: number;
  end: number;
}



export interface OnlyMatchingMatches {
  matchCount: number;
  ranges: LineRange[];
  entriesByLine: Map<number, FileSystemSearchTextEntry[]>;
}



export interface RipgrepSearchPlan {
  args: RgArg[];
  outputRoot: string;
  preopens: Record<string, string>;
}



export interface ParsedTextSearch {
  entries: FileSystemSearchTextEntry[];
  files: string[];
  numMatches: number;
}



export interface FinishTextSearchParams {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  startedAt: number;
  request: FileSystemSearchTextRequest;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
}



export class RipgrepRuntimeFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Bundled ripgrep WASM failed to run");
    this.name = "RipgrepRuntimeFailure";
    this.cause = cause;
  }
}



export class RipgrepTimeoutFailure extends Error {
  constructor(timeoutMs: number) {
    super(
      `ripgrep search timed out after ${timeoutMs}ms. The search was terminated before it completed.`,
    );
    this.name = "RipgrepTimeoutFailure";
  }
}



export interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    submatches?: Array<{ match?: { text?: string } }>;
    line_number?: number;
  };
}



export const TYPE_EXTENSION_MAP: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  go: [".go"],
  html: [".html", ".htm"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  markdown: [".md", ".markdown"],
  md: [".md", ".markdown"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  sh: [".sh", ".bash", ".zsh"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  tsx: [".tsx"],
  txt: [".txt"],
  yaml: [".yaml", ".yml"],
};



export class SymlinkWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkWriteRefusedError";
  }
}



export let ripgrepWorkerFactoryForTests: RipgrepWorkerFactory | undefined;


export let ripgrepTimeoutMsForTests: number | undefined;



export function setRipgrepWorkerFactoryForTests(
  factory: RipgrepWorkerFactory | undefined,
): () => void {
  const previous = ripgrepWorkerFactoryForTests;
  ripgrepWorkerFactoryForTests = factory;
  return () => {
    ripgrepWorkerFactoryForTests = previous;
  };
}



export function setRipgrepTimeoutMsForTests(timeoutMs: number | undefined): () => void {
  const previous = ripgrepTimeoutMsForTests;
  ripgrepTimeoutMsForTests = timeoutMs;
  return () => {
    ripgrepTimeoutMsForTests = previous;
  };
}
