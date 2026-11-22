/**
 * cli-exec-pty 对外契约.
 *
 * Модуль даёт агенту интерактивные терминальные сессии: визарды, REPL, dev-серверы.
 * Ключевые свойства, на которые опирается вызывающий:
 * - Чтение инкрементальное и без потерь: у каждого чанка монотонный `seq`,
 *   поэтому агент передаёт `sinceSeq` и получает только новое.
 * - Вывод очищен от ANSI-управляющих последовательностей, но сами они
 *   перечислены в `controlSequences`, а вытесненные данные отмечены `truncatedFrom`.
 * - Уничтожение сессии гарантированно снимает дерево процессов по PGID.
 * - Песочница та же, что у Bash: `sandboxMode` возвращается в каждом снимке.
 */

/** Идентификатор PTY-сессии; уникален в пределах менеджера. */
export type PtySessionId = string & { readonly __brand: "PtySessionId" };

/** Состояние сессии. */
export type PtySessionStatus = "running" | "exited" | "killed";

/** Режим песочницы, фактически применённый к PTY. */
export type PtySandboxMode = "bwrap" | "seatbelt" | "degraded" | "none";

/** Один прочитанный фрагмент вывода. */
export interface PtyChunk {
  /** Монотонный номер чанка в сессии; используется как `sinceSeq`. */
  seq: number;
  /** Текст без ANSI/CSI escape-последовательностей. */
  text: string;
  /** Управляющие последовательности, вырезанные из `text`. */
  controlSequences: readonly string[];
  /** Время получения чанка (epoch ms). */
  at: number;
}

export interface PtySandboxOptions {
  profile?: "off" | "workspace-write" | "strict-offline";
  networkAccess?: "allow" | "deny";
  writableRoots?: readonly string[];
}

export interface PtyCreateOptions {
  cwd: string;
  /** Корень workspace для политики песочницы; по умолчанию равен `cwd`. */
  workspacePath?: string;
  shell?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
  /** Политика изоляции; `off` запускает shell без песочницы. */
  sandbox?: PtySandboxOptions;
  /** Сколько байт хранить в кольцевом буфере; по умолчанию 1 МиБ. */
  maxBufferBytes?: number;
  /** Тишина, после которой сессия считается ожидающей ввода. */
  idleMs?: number;
}

/** Снимок состояния сессии без вывода. */
export interface PtySessionInfo {
  sessionId: PtySessionId;
  status: PtySessionStatus;
  pid: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  sandboxMode: PtySandboxMode;
  sandboxReason?: string;
  createdAt: number;
  /** Код выхода; присутствует при `status !== "running"`. */
  exitCode?: number;
  signal?: number;
  /** Последний выданный seq. */
  lastSeq: number;
  /** Самый старый доступный seq в буфере. */
  firstSeq: number;
  /** Сколько байт вытеснено из кольцевого буфера. */
  truncatedBytes: number;
}

/** Результат чтения: дельта вывода и текущее состояние. */
export interface PtyReadResult {
  session: PtySessionInfo;
  chunks: readonly PtyChunk[];
  /** `true`, если запрошенный `sinceSeq` старше буфера и часть данных потеряна. */
  truncatedFrom?: number;
}

export interface PtyWaitOptions {
  /** Ждать появления текста в новом выводе. */
  pattern?: string | RegExp;
  /** Ждать тишины (в мс) после последнего чанка. */
  idleMs?: number;
  /** Ждать конкретного кода выхода. */
  exitCode?: number;
  /** Предел ожидания; по умолчанию 30 000 мс. */
  timeoutMs?: number;
}

export type PtyWaitMatch = "pattern" | "idle" | "exit" | "timeout";

export interface PtyWaitResult {
  session: PtySessionInfo;
  /** Сработавшее условие; `timeout`, если ничего не совпало. */
  matched: PtyWaitMatch;
  chunks: readonly PtyChunk[];
  /** Часть вывода, совпавшая с `pattern`. */
  match?: string;
}

export interface PtyKillOptions {
  signal?: string;
  /** Сколько ждать между мягким и жёстким сигналом. */
  graceMs?: number;
}

export interface PtyManagerLimits {
  /** Сколько сессий держать одновременно; по умолчанию 4. */
  maxSessions?: number;
  /** Тишина, после которой сессия считается простаивающей; по умолчанию 10 мин. */
  idleTimeoutMs?: number;
}

/** Публичный контракт: один метод — одно намерение. */
export interface AgentPtyManagerContract {
  /** Создаёт сессию и возвращает её снимок. Ошибка spawn — отклонённый Promise. */
  create(options: PtyCreateOptions): Promise<PtySessionInfo>;
  /** Пишет данные в stdin. */
  write(sessionId: PtySessionId, data: string): Promise<void>;
  /** Меняет размер терминала. */
  resize(sessionId: PtySessionId, cols: number, rows: number): Promise<void>;
  /** Читает вывод начиная с `sinceSeq` (эксклюзивно). */
  read(sessionId: PtySessionId, options?: { sinceSeq?: number }): Promise<PtyReadResult>;
  /** Ждёт условия по выводу, тишине или коду выхода. */
  waitFor(sessionId: PtySessionId, options: PtyWaitOptions): Promise<PtyWaitResult>;
  /** Уничтожает сессию и её дерево процессов. Идемпотентно. */
  kill(sessionId: PtySessionId, options?: PtyKillOptions): Promise<PtySessionInfo>;
  /** Список живых и завершённых сессий. */
  list(): readonly PtySessionInfo[];
  /** Закрывает все сессии, освобождает дескрипторы и таймеры. */
  dispose(): Promise<void>;
}

/** Размер кольцевого буфера по умолчанию на сессию. */
export const PTY_DEFAULT_BUFFER_BYTES = 1024 * 1024;

/** Сколько сессий по умолчанию разрешено агенту. */
export const PTY_DEFAULT_MAX_SESSIONS = 4;

/** Тишина по умолчанию для `waitFor({ idleMs })`. */
export const PTY_DEFAULT_IDLE_MS = 400;

/** Таймаут ожидания по умолчанию. */
export const PTY_DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Простой, после которого сессия закрывается автоматически. */
export const PTY_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Размеры терминала по умолчанию. */
export const PTY_DEFAULT_COLS = 120;
export const PTY_DEFAULT_ROWS = 40;
