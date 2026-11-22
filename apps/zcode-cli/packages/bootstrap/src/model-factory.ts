// Model factory - creates model adapter with config

import {
  createModelRequestSecurityState,
  AiSdkModelAdapter,
  type OpenCodeModelProviderRuntime,
  type CursorProvider,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@zcode/adapters/model";
import type { Logger, ModelStatusSink } from "@zcode/contracts";

interface CreateModelAdapterBaseOptions {
  env?: EnvRecord;
  logger?: Logger;
  modelIoDir?: string;
  modelIoFullRetentionEnabled?: boolean;
  streamIdleTimeoutMs?: number;
  /** 首 token 看门狗窗口（ms）；<=0 关闭。与 streamIdleTimeoutMs 相互独立。 */
  firstTokenTimeoutMs?: number;
  statusSink?: ModelStatusSink;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
  opencodeProvider?: OpenCodeModelProviderRuntime["provider"];
  cursorProvider?: CursorProvider;
};

// 可复用资源由进程拥有，每个 execution 保留自己的请求状态。
const processRequestSecurityState = createModelRequestSecurityState();

export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    requestSecurityState: processRequestSecurityState,
    debugDir: options.modelIoDir,
    env: options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    statusSink: options.statusSink,
    ...(options.opencodeProvider ? { opencodeProvider: options.opencodeProvider } : {}),
    ...(options.cursorProvider ? { cursorProvider: options.cursorProvider } : {}),
  });
}
