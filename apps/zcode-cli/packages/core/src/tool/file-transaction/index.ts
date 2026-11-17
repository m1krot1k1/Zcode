export {
  DEFAULT_FILE_LOCK_TIMEOUT_MS,
  FILE_LOCK_TIMEOUT_CODE,
  type ActiveFileLockStateSnapshot,
  type FileLockAcquireOptions,
  type FileLockGrant,
  type FileLockMode,
  type FileLockRequestEntry,
  type FileMutationOp,
  type IFileLockRegistry,
  type SyntaxValidationDiagnostic,
} from "./contract.js";
export { FileLockRegistry, createFileLockRegistry } from "./lock-registry.js";
