import type { ConfigResult } from "@zcode/adapters/config";
import type { AiSdkModelAdapter, OpenCodeModelProviderRuntime } from "@zcode/adapters/model";
import type { AgentRuntime, ResumeSessionResult } from "@zcode/core";
import type { Logger, LoggerFactory, SessionId, TraceContext } from "@zcode/contracts";
import type { createModelTelemetry } from "@zcode/telemetry";
import type { StartupTimer } from "../startup-logging.js";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import type { PrepareUserExecutionBoundary, ResumeOptions, ZCodeAppOptions } from "./types.js";

/** Порт телеметрии модели: владелец — стадия окружения, освобождает точка входа. */
export type ModelTelemetry = ReturnType<typeof createModelTelemetry>;

/** Неизменяемые входы стадий: собираются один раз в createZCodeApp. */
export interface CreateAppDeps {
  options: ZCodeAppOptions;
  logger: Logger;
  loggerFactory: LoggerFactory;
  modelLogger: Logger;
  modelTelemetry: ModelTelemetry;
  startupTimer: StartupTimer;
  configResult: ConfigResult;
  traceContext: TraceContext;
  sessionId: SessionId;
  workingDirectory: string;
  appVersion: string;
}

/** Мутируемое состояние владения: стадии заполняют его, catch в точке входа освобождает. */
export interface CreateAppState {
  runtime?: AgentRuntime;
  providerModelRuntime?: ApiProviderModelRuntime;
  ownedOpenCodeModelRuntime?: OpenCodeModelProviderRuntime;
  ownedModelAdapter?: AiSdkModelAdapter;
  ownedNodeReplBrowserBroker?: NodeReplBrowserBroker;
}

/** Замыкания границы сессии, общие для портов, workflow и фасадов. */
export interface SessionBoundary {
  getRuntime(): AgentRuntime;
  initializeSessionShellEnvironment(): Promise<void>;
  restorePersistedModelSelection(): Promise<ResumeSessionResult["modelSelection"]>;
  resumeFromStore(resumeOptions?: ResumeOptions): Promise<ResumeSessionResult>;
  prepareResume(submitTraceContext?: TraceContext, abortSignal?: AbortSignal): Promise<void>;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
}
