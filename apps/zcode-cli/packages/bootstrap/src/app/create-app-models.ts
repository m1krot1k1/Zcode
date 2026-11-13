import { createOpenCodeModelProvider } from "@zcode/adapters/model";

import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { createModelAdapter } from "../model-factory.js";
import type { AppEnvironment } from "./create-app-env.js";
import type { CreateAppDeps, CreateAppState } from "./create-app-contracts.js";
import type { AppPorts } from "./create-app-ports.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";

/** Модельный рантайм: adapter, provider runtime и общий model factory. */
export interface AppModels {
  modelAdapter: ReturnType<typeof createModelAdapter>;
  modelFactory: ApiProviderModelRuntime["modelFactory"];
  workflowConcurrencyGovernor: ReturnType<typeof getWorkflowConcurrencyGovernor>;
}

export async function prepareAppModels(
  deps: CreateAppDeps,
  env: AppEnvironment,
  ports: AppPorts,
  state: CreateAppState,
): Promise<AppModels> {
  const { options, configResult, appVersion, modelLogger, modelTelemetry } = deps;
  const { modelIoDir } = env;
  const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
    appVersion,
    endpointRoutingPort: ports.providerEndpointRoutingPort,
    network: configResult.config.network,
    sourceTitle: options.sourceTitle,
  });
  if (!options.modelAdapter) {
    // 修复依据：目录同步只注册了 opencode-sdk 配置，生产 ModelExecution 从未获得 SDK 实例。
    // 每个拥有 adapter 的 CLI App 现在创建一个运行时实例，并由同一 App 负责释放。
    state.ownedOpenCodeModelRuntime = await createOpenCodeModelProvider();
    state.ownedModelAdapter = createModelAdapter({
      env: options.env,
      logger: modelLogger,
      modelIoDir,
      modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
      executionConfig: modelExecutionConfig,
      statusSink: modelTelemetry.statusSink,
      streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      firstTokenTimeoutMs: configResult.config.modelStream.firstTokenTimeoutMs,
      opencodeProvider: state.ownedOpenCodeModelRuntime.provider,
    });
  }
  const modelAdapter = options.modelAdapter ?? state.ownedModelAdapter!;
  if (options.modelAdapter && modelTelemetry.statusSink) {
    modelAdapter.addStatusSink(modelTelemetry.statusSink);
  }
  // 进程级并发治理器：run service 拿它的窄端口给
  // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
  // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
  // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
  const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
  modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
  const providerModelRuntime = new ApiProviderModelRuntime({
    registry: options.providerRegistry,
    modelAdapter,
    onProviderFallback: (event) => {
      modelLogger.info("Provider fallback after quota exhaustion", {
        from: event.from,
        to: event.to,
        reason: event.reason,
      });
    },
  });
  state.providerModelRuntime = providerModelRuntime;
  providerModelRuntime.start();
  // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
  // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
  // 新建的 Model 才看得到，child 不各自冻结一份。
  const modelFactory = providerModelRuntime.modelFactory;
  return { modelAdapter, modelFactory, workflowConcurrencyGovernor };
}
