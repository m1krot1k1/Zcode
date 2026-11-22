/** ANR：主线程无响应阈值（与 Electron unresponsive 对齐） */
export const STABILITY_ANR_THRESHOLD_MS = 5_000;
/** 挂死：未恢复且未 crash 的更长无响应阈值 */
export const STABILITY_FREEZE_THRESHOLD_MS = 30_000;
export const AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH = 4_000;
export const STABILITY_TELEMETRY_SCHEMA_VERSION = 2;
export const WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE = 0x40010004;
export const AGENT_EXCEPTION_DEDUP_CAPACITY = 1024;
