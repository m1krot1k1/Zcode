/**
 * cli-exec-sandbox 对外契约.
 *
 * Модуль отвечает за две вещи, которые нельзя разнести:
 *   1. Реальная ОС-изоляция процесса (`bubblewrap` на Linux, `sandbox-exec` Seatbelt на macOS)
 *      с честным статусом `degraded`, когда механизм недоступен.
 *   2. Гарантированное уничтожение дерева процессов по идентификатору группы.
 *
 * Семантика:
 * - `probe()` кэширует результат на TTL и никогда не бросает: недоступность механизма —
 *   это значение (`available: false` + `reason`), а не исключение.
 * - `wrap()` всегда возвращает исполнимую команду. При `degraded` это реальная защита
 *   доступного уровня (chdir, очистка env, `ulimit`), а не пустая обёртка.
 * - `killTree()` идемпотентен: уже завершённый процесс не переводится в ошибку,
 *   чужие процессы и собственный PID вызывающего не затрагиваются.
 */

/** Кто реально исполнил команду. Значение попадает в результат инструмента. */
export type SandboxMode = "bwrap" | "seatbelt" | "degraded" | "none";

/** Политика изоляции; `off` — без песочницы (используется, когда изоляция запрещена). */
export type SandboxProfile = "off" | "workspace-write" | "strict-offline";

export type SandboxNetworkAccess = "allow" | "deny";

/**
 * Ресурсные лимиты. Применяются реально: через `ulimit` в `degraded`-режиме и
 * через `prlimit` либо `ulimit`-обёртку внутри `bwrap`.
 */
export interface SandboxLimits {
  /** CPU-время процесса в секундах (`ulimit -t`). */
  cpuSeconds?: number;
  /** Виртуальная память в байтах (`ulimit -v`, переводится в KiB). */
  memoryBytes?: number;
  /** Максимальное число процессов пользователя (`ulimit -u`). */
  maxProcesses?: number;
  /** Максимальный размер создаваемого файла в байтах (`ulimit -f`, переводится в 512-байтные блоки). */
  maxFileSizeBytes?: number;
}

/** Результат зондирования механизма изоляции. */
export interface SandboxCapability {
  /** Максимально доступный механизм на этой машине. */
  mode: Exclude<SandboxMode, "none">;
  /** Прошёл ли самотест реального запуска. */
  available: boolean;
  /** Версия механизма, если её удалось прочитать. */
  version?: string;
  /** Причина недоступности либо деградации; всегда заполнена при `available: false`. */
  reason?: string;
  /** Флаги, которые механизм принимает (проверено по `--help`/версии). */
  supportedFlags: readonly string[];
  /** Момент зондирования (epoch ms) — для TTL-кэша и диагностики. */
  probedAt: number;
  /** Сколько занял самотест, мс. */
  probeDurationMs: number;
}

/** Входная команда до обёртки. */
export interface SandboxCommand {
  file: string;
  args: readonly string[];
}

/** Политика изоляции одного запуска. */
export interface SandboxPolicy {
  profile?: SandboxProfile;
  /** Рабочий каталог процесса; монтируется на запись, если входит в workspace. */
  cwd: string;
  /** Корень workspace: единственный каталог, доступный на запись по умолчанию. */
  workspacePath: string;
  /** Дополнительные каталоги на запись (кэши пакетных менеджеров и т.п.). */
  writableRoots?: readonly string[];
  /** Дополнительные каталоги, которые нужно принудительно оставить read-only. */
  readOnlyRoots?: readonly string[];
  networkAccess?: SandboxNetworkAccess;
  /** Прокидывать `/dev` внутрь песочницы. */
  allowDevices?: boolean;
  /** Whitelisted переменные окружения: значение передаётся внутрь как есть. */
  env?: Readonly<Record<string, string>>;
  /**
   * `true` — не наследовать окружение вызывающего вовсе (только `env`).
   * По умолчанию наследуются только whitelisted переменные, остальное отбрасывается.
   */
  envIsolated?: boolean;
  /**
   * Каталог, в который процесс пишет служебные файлы (например, захват cwd).
   * Монтируется отдельным bind поверх изолированного `/tmp`.
   */
  cwdCaptureDir?: string;
  limits?: SandboxLimits;
}

/** Готовая к запуску команда с применённой политикой. */
export interface SandboxedCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Фактический режим изоляции этого запуска. */
  sandboxMode: SandboxMode;
  /** Причина деградации, если `sandboxMode === "degraded"`. */
  sandboxReason?: string;
  /** Лимиты, реально применённые к запуску. */
  limits: SandboxLimits;
  /** Признак реальной изоляции ФС (не просто chdir). */
  filesystemIsolated: boolean;
  /** Признак реальной сетевой изоляции. */
  networkIsolated: boolean;
}

export interface ProcessTreeKillOptions {
  /** Сигнал мягкой остановки; по умолчанию `SIGTERM`. */
  signal?: NodeJS.Signals;
  /** Сколько ждать после мягкого сигнала до `SIGKILL`. */
  graceMs?: number;
  /** Переопределение платформы (тесты и Windows-ветка). */
  platform?: NodeJS.Platform;
  /** Таймаут ожидания таблицы процессов, мс. */
  lookupTimeoutMs?: number;
}

export interface ProcessTreeKillResult {
  /** Корневой PID, по которому пришёл запрос. */
  rootPid: number;
  /** Был ли отправлен жёсткий сигнал. */
  escalated: boolean;
  /** Сколько процессов получило сигнал (корень + потомки + группа). */
  signalled: number;
  /** Остались ли живые процессы после эскалации. */
  survivors: readonly number[];
  /** Группа уже не существовала к моменту вызова (нормальный случай, не ошибка). */
  alreadyExited: boolean;
}

/** Публичный контракт модуля. Один метод — одно намерение. */
export interface ExecutionSandboxContract {
  /** Зондирует механизм изоляции. Кэшируется на TTL; ошибки возвращаются значением. */
  probe(options?: { force?: boolean; ttlMs?: number }): Promise<SandboxCapability>;
  /** Применяет политику к команде и возвращает исполнимый argv/env/cwd. */
  wrap(command: SandboxCommand, policy: SandboxPolicy): Promise<SandboxedCommand>;
  /** Уничтожает дерево процессов по корневому PID. Идемпотентно и безопасно для чужих PID. */
  killTree(rootPid: number, options?: ProcessTreeKillOptions): Promise<ProcessTreeKillResult>;
}

/** Переменные, которые по умолчанию разрешены к наследованию в песочницу. */
export const SANDBOX_ENV_WHITELIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "COLUMNS",
  "LINES",
  "CI",
];

/** Сколько живёт результат `probe()` по умолчанию. */
export const SANDBOX_PROBE_TTL_MS = 60_000;

/** Сколько по умолчанию ждём между `SIGTERM` и `SIGKILL`. */
export const SANDBOX_KILL_GRACE_MS = 1_500;
