/**
 * Пул интерактивных PTY-сессий агента поверх `node-pty`.
 *
 * Владелец состояния — этот класс: он держит дескрипторы, таймеры простоя и
 * буферы. Наружу отдаются только снимки (`PtySessionInfo`), чтобы вызывающий не
 * мог изменить внутреннее состояние в обход API.
 *
 * Инварианты:
 * - `create()` уважает `maxSessions` и не оставляет «полусессию» при ошибке spawn.
 * - `write()`/`resize()` на завершённой сессии — тихая идемпотентность: агент
 *   часто пишет в гонке с exit, и это не должно валить инструмент.
 * - `kill()` снимает всё дерево процессов через `ExecutionSandbox.killTree`.
 * - `dispose()` закрывает все сессии и снимает все таймеры: после него не
 *   остаётся живых дескрипторов.
 */
import type { IPty } from "node-pty";

import {
  PTY_DEFAULT_BUFFER_BYTES,
  PTY_DEFAULT_COLS,
  PTY_DEFAULT_IDLE_MS,
  PTY_DEFAULT_IDLE_TIMEOUT_MS,
  PTY_DEFAULT_MAX_SESSIONS,
  PTY_DEFAULT_ROWS,
  PTY_DEFAULT_WAIT_TIMEOUT_MS,
  type AgentPtyManagerContract,
  type PtyCreateOptions,
  type PtyKillOptions,
  type PtyManagerLimits,
  type PtyReadResult,
  type PtySandboxMode,
  type PtySessionId,
  type PtySessionInfo,
  type PtySessionStatus,
  type PtyWaitOptions,
  type PtyWaitResult,
} from "./contract.js";
import { AnsiRingBuffer } from "./ansi-ring-buffer.js";
// Публичный вход cli-exec-sandbox: deep-import реализации запрещён политикой.
import { createExecutionSandbox, type ExecutionSandboxContract } from "../sandbox/index.js";

interface PtySession {
  id: PtySessionId;
  term: IPty;
  buffer: AnsiRingBuffer;
  status: PtySessionStatus;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  sandboxMode: PtySandboxMode;
  sandboxReason?: string;
  createdAt: number;
  exitCode?: number;
  signal?: number;
  idleTimer?: NodeJS.Timeout;
  /** Слушатели `waitFor`; оповещаются на каждый новый чанк. */
  waiters: Set<() => void>;
}

type NodePtySpawn = typeof import("node-pty").spawn;
let cachedNodePtySpawn: NodePtySpawn | undefined;

/**
 * `node-pty` — нативный аддон. Загружаем его только при первом PTY-вызове:
 * упакованный `zcode.cjs` исполняется из `resources/glm`, а storage startup
 * и обычный запуск CLI не должны зависеть от наличия native-модуля.
 */
async function loadNodePtySpawn(): Promise<NodePtySpawn> {
  if (!cachedNodePtySpawn) {
    const nodePty = await import("node-pty");
    cachedNodePtySpawn = nodePty.spawn;
  }
  return cachedNodePtySpawn;
}

export interface AgentPtyManagerOptions extends PtyManagerLimits {
  sandbox?: ExecutionSandboxContract;
  /** Платформа для песочницы и убийства дерева; подменяется в тестах. */
  platform?: NodeJS.Platform;
  /** Фабрика PTY; подменяется в тестах без реального `node-pty`. */
  spawnPty?: NodePtySpawn;
}

/** Дефолтный shell для платформы: у агента должен быть предсказуемый. */
export function resolveDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") return env.ComSpec ?? "cmd.exe";
  return env.SHELL?.trim() || "/bin/sh";
}

export class AgentPtyManager implements AgentPtyManagerContract {
  private readonly sessions = new Map<string, PtySession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly sandbox: ExecutionSandboxContract;
  private readonly platform: NodeJS.Platform;
  private readonly spawnPtyImpl?: NodePtySpawn;
  private disposed = false;

  constructor(options: AgentPtyManagerOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? PTY_DEFAULT_MAX_SESSIONS);
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? PTY_DEFAULT_IDLE_TIMEOUT_MS);
    this.platform = options.platform ?? process.platform;
    this.spawnPtyImpl = options.spawnPty;
    this.sandbox =
      options.sandbox ?? createExecutionSandbox({ platform: this.platform });
  }

  async create(options: PtyCreateOptions): Promise<PtySessionInfo> {
    this.assertNotDisposed();
    this.evictIdleSessions();
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `PTY session limit reached (${this.maxSessions}). Kill an existing session first.`,
      );
    }

    const shell = options.shell?.trim() || resolveDefaultShell(this.platform);
    const cols = options.cols ?? PTY_DEFAULT_COLS;
    const rows = options.rows ?? PTY_DEFAULT_ROWS;
    const workspacePath = options.workspacePath ?? options.cwd;
    const env = options.env ? { ...options.env } : { ...process.env } as Record<string, string>;

    // Песочница применяется к shell внутри PTY: та же политика, что у Bash.
    const wrap = options.sandbox?.profile ?? "workspace-write";
    let file = shell;
    let args = options.args ? [...options.args] : [];
    let sandboxMode: PtySandboxMode = "none";
    let sandboxReason: string | undefined;
    if (wrap !== "off") {
      const wrapped = await this.sandbox.wrap(
        { file: shell, args },
        {
          profile: wrap,
          cwd: options.cwd,
          workspacePath,
          networkAccess: options.sandbox?.networkAccess ?? "allow",
          ...(options.sandbox?.writableRoots
            ? { writableRoots: options.sandbox.writableRoots }
            : {}),
          env,
        },
      );
      file = wrapped.file;
      args = wrapped.args;
      sandboxMode = wrapped.sandboxMode;
      sandboxReason = wrapped.sandboxReason;
      Object.assign(env, wrapped.env);
    } else {
      sandboxMode = "none";
    }

    const spawnPty = this.spawnPtyImpl ?? (await loadNodePtySpawn());
    const term = spawnPty(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env,
    });

    const id = `pty_${crypto.randomUUID()}` as PtySessionId;
    const buffer = new AnsiRingBuffer(options.maxBufferBytes ?? PTY_DEFAULT_BUFFER_BYTES);
    const session: PtySession = {
      id,
      term,
      buffer,
      status: "running",
      cwd: options.cwd,
      shell,
      cols,
      rows,
      sandboxMode,
      ...(sandboxReason ? { sandboxReason } : {}),
      createdAt: Date.now(),
      waiters: new Set(),
    };
    this.sessions.set(id, session);

    term.onData((data) => {
      // Буфер сам разбирает ANSI и вытесняет старое; здесь только оповещение.
      buffer.append(data);
      for (const notify of session.waiters) notify();
    });
    term.onExit(({ exitCode, signal }) => {
      session.status = session.status === "killed" ? "killed" : "exited";
      session.exitCode = exitCode;
      session.signal = signal;
      this.clearIdleTimer(session);
      for (const notify of session.waiters) notify();
    });

    this.armIdleTimer(session, options.idleMs);
    return this.snapshot(session);
  }

  async write(sessionId: PtySessionId, data: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status !== "running") return;
    session.term.write(data);
    this.touch(session);
  }

  async resize(sessionId: PtySessionId, cols: number, rows: number): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status !== "running") return;
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    session.term.resize(safeCols, safeRows);
    session.cols = safeCols;
    session.rows = safeRows;
    this.touch(session);
  }

  async read(sessionId: PtySessionId, options: { sinceSeq?: number } = {}): Promise<PtyReadResult> {
    const session = this.requireSession(sessionId);
    const { chunks, truncatedFrom } = session.buffer.readAsChunks(options.sinceSeq ?? 0);
    return {
      session: this.snapshot(session),
      chunks,
      ...(truncatedFrom !== undefined ? { truncatedFrom } : {}),
    };
  }

  async waitFor(sessionId: PtySessionId, options: PtyWaitOptions): Promise<PtyWaitResult> {
    const session = this.requireSession(sessionId);
    const timeoutMs = Math.max(1, options.timeoutMs ?? PTY_DEFAULT_WAIT_TIMEOUT_MS);
    const idleMs = options.idleMs ?? PTY_DEFAULT_IDLE_MS;
    const sinceSeq = session.buffer.lastSeq;
    const pattern = normalizePattern(options.pattern);

    const deadline = Date.now() + timeoutMs;
    let lastSeenSeq = -1;
    let lastActivityAt = Date.now();

    return new Promise<PtyWaitResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (matched: PtyWaitResult["matched"], match?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        session.waiters.delete(check);
        resolve({
          session: this.snapshot(session),
          matched,
          chunks: session.buffer.readAsChunks(sinceSeq).chunks,
          ...(match !== undefined ? { match } : {}),
        });
      };

      const check = () => {
        if (settled) return;
        const currentSeq = session.buffer.lastSeq;
        if (currentSeq !== lastSeenSeq) {
          lastSeenSeq = currentSeq;
          lastActivityAt = Date.now();
        }

        if (options.exitCode !== undefined && session.exitCode === options.exitCode) {
          finish("exit");
          return;
        }
        if (session.status !== "running" && options.exitCode === undefined && !options.pattern) {
          finish("exit");
          return;
        }
        if (pattern) {
          const text = session.buffer.textSince(sinceSeq);
          const matched = pattern.exec(text);
          if (matched) {
            finish("pattern", matched[0]);
            return;
          }
        }
        if (
          options.pattern === undefined &&
          options.exitCode === undefined &&
          Date.now() - lastActivityAt >= idleMs
        ) {
          finish("idle");
          return;
        }
        if (Date.now() >= deadline) {
          finish("timeout");
        }
      };

      session.waiters.add(check);
      // Периодический опрос нужен для idle/exit: onData не сработает на тишину.
      timer = setInterval(check, Math.min(100, Math.max(20, Math.floor(timeoutMs / 20))));
      timer.unref?.();
      check();
    });
  }

  async kill(sessionId: PtySessionId, options: PtyKillOptions = {}): Promise<PtySessionInfo> {
    const session = this.requireSession(sessionId);
    if (session.status === "running") {
      session.status = "killed";
      // Сначала PGID-дерево (shell + потомки), затем закрытие дескриптора PTY.
      try {
        await this.sandbox.killTree(session.term.pid, {
          signal: (options.signal as NodeJS.Signals | undefined) ?? "SIGTERM",
          ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
        });
      } catch {
        // Дерево могло завершиться само; закрытие PTY ниже всё равно выполняется.
      }
      try {
        session.term.kill();
      } catch {
        // Процесс уже мёртв — это нормальный исход kill().
      }
    }
    this.clearIdleTimer(session);
    for (const notify of session.waiters) notify();
    return this.snapshot(session);
  }

  list(): readonly PtySessionInfo[] {
    return [...this.sessions.values()].map((session) => this.snapshot(session));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) {
      this.clearIdleTimer(session);
      if (session.status === "running") {
        session.status = "killed";
        try {
          await this.sandbox.killTree(session.term.pid, { graceMs: 200 });
        } catch {
          // Дерево могло уже завершиться.
        }
        try {
          session.term.kill();
        } catch {
          // Дескриптор мог закрыться сам.
        }
      }
      for (const notify of session.waiters) notify();
      session.waiters.clear();
      session.buffer.clear();
    }
    this.sessions.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("AgentPtyManager has been disposed");
  }

  private requireSession(sessionId: PtySessionId): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown PTY session: ${sessionId}`);
    return session;
  }

  private touch(session: PtySession): void {
    this.armIdleTimer(session, undefined);
  }

  /** Таймер простоя: закрывает забытую сессию, чтобы не течь дескрипторами. */
  private armIdleTimer(session: PtySession, idleMs: number | undefined): void {
    this.clearIdleTimer(session);
    if (this.idleTimeoutMs <= 0) return;
    const delay = idleMs && idleMs > 0 ? Math.max(idleMs, this.idleTimeoutMs) : this.idleTimeoutMs;
    session.idleTimer = setTimeout(() => {
      if (session.status !== "running") return;
      void this.kill(session.id, { graceMs: 300 }).catch(() => undefined);
    }, delay);
    session.idleTimer.unref?.();
  }

  private clearIdleTimer(session: PtySession): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  /** Вытесняет завершённые сессии перед созданием новой. */
  private evictIdleSessions(): void {
    // Array.from, а не прямой обход: мы удаляем элементы из той же Map внутри цикла.
    for (const session of Array.from(this.sessions.values())) {
      if (session.status === "running") continue;
      this.sessions.delete(session.id);
    }
  }

  private snapshot(session: PtySession): PtySessionInfo {
    return {
      sessionId: session.id,
      status: session.status,
      pid: session.term.pid,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      sandboxMode: session.sandboxMode,
      ...(session.sandboxReason ? { sandboxReason: session.sandboxReason } : {}),
      createdAt: session.createdAt,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      lastSeq: session.buffer.lastSeq,
      firstSeq: session.buffer.firstSeq,
      truncatedBytes: session.buffer.truncatedBytes,
    };
  }
}

function normalizePattern(pattern: string | RegExp | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  if (pattern instanceof RegExp) {
    // Копия без g-флага: exec с глобальным флагом хранит lastIndex между вызовами.
    return new RegExp(pattern.source, pattern.flags.replace(/g/g, ""));
  }
  return new RegExp(pattern);
}

export function createAgentPtyManager(
  options: AgentPtyManagerOptions = {},
): AgentPtyManager {
  return new AgentPtyManager(options);
}
