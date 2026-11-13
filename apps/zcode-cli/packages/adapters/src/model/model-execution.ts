// ============================================================
// Vercel AI SDK model execution
// ============================================================
//
// Публичный фасад разбит на модули в ./model-execution/: привязка провайдера,
// бизнес-ошибки провайдера, проекция OpenCode invocation и runtime OpenCode.

export { AiSdkModelExecution } from "./model-execution/provider-factory.js";
export {
  ProviderBusinessError,
  isProviderBusinessError,
  readProviderBusinessFailureFromBody,
} from "./model-execution/provider-business-error.js";
export type {
  ProviderBusinessErrorFetchOptions,
  ProviderBusinessErrorOptions,
} from "./model-execution/provider-business-error.js";
export { createProviderBusinessErrorFetch } from "./model-execution/provider-business-error-fetch.js";
export {
  OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS,
  projectOpenCodePrompt,
} from "./model-execution/opencode-invocation.js";
export {
  createOpenCodeDiagnosticFetch,
  createOpenCodeInvocationConfig,
  createOpenCodeModelProvider,
  preferOpenCodeE2ECliOnPath,
} from "./model-execution/opencode-provider.js";
export type {
  OpenCodeModelProvider,
  OpenCodeModelProviderRuntime,
} from "./model-execution/opencode-provider.js";
export type {
  AiSdkBoundModelResolution,
  AiSdkModelExecutionConfig,
  AiSdkModelExecutionOptions,
  AiSdkNetworkConfig,
  AiSdkProviderKind,
  AiSdkResolvedModel,
  EnvRecord,
} from "./model-execution/types.js";
