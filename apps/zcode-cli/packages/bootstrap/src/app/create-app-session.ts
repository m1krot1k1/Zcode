import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AgentRuntime,
  buildPluginReferenceCatalog,
  getProcessWorkLedger,
  normalizeAgentProfiles,
  writeWorkflowDraft,
  type AgentRuntimeDeps,
} from "@zcode/core";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import type { PluginSubagentModelSelectionOverrides } from "@zcode/shared";
import { subagentProfilesFromSnapshot } from "../runtime-subagents/index.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import {
  loadPluginAgentTemplates,
  loadZCodeAgentProfiles,
  resolvePluginAgentProfiles,
} from "../subagents.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createCapabilityInstallPort } from "./capability-install-port.js";
import { getPluginStorageRoot } from "./paths.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";
import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type { AppEnvironment } from "./create-app-env.js";
import type {
  CreateAppDeps,
  CreateAppState,
  SessionBoundary,
} from "./create-app-contracts.js";
import type { AppModels } from "./create-app-models.js";
import type { AppPorts } from "./create-app-ports.js";
import { completeAppStartup, markRuntimeConstructed } from "./startup-marks.js";

/** Рабочее ядро сессии: workflow-мосты, dwf-сервисы и AgentRuntime. */
export interface PluginRuntimeActivationResult {
  connected: string[];
  disconnected: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface AppSession {
  runtime: AgentRuntime;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  dynamicWorkflowSnippetPort: ReturnType<typeof createDynamicWorkflowSnippetService>;
  modelCatalogPort: ReturnType<typeof createModelCatalogPort>;
  /** Перечитать plugin data-plane и definitions в живом runtime без reload. */
  refreshPluginComponents(): Promise<PluginRuntimeActivationResult>;
}

export function prepareAppSession(
  deps: CreateAppDeps,
  env: AppEnvironment,
  ports: AppPorts,
  models: AppModels,
  boundary: SessionBoundary,
  state: CreateAppState,
): AppSession {
  const { options, logger, configResult, traceContext, sessionId, workingDirectory, appVersion } =
    deps;
  const {
    artifactStore,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    mcpPort,
    permissionService,
    executionPort,
    sessionMailboxPort,
    workspaceHookRuntimeSecurity,
    ptySessionPort,
  } = ports;
  const {
    pluginOutcome,
    pluginCatalog,
    bundledSkillRoots,
    runtimeConfig,
    sessionStore,
    browserControlPort,
  } = env;
  const { modelFactory, modelFacts, workflowConcurrencyGovernor } = models;
  const { modelTelemetry } = deps;
  const { getRuntime, prepareUserExecutionBoundary } = boundary;
  const scriptWorkflowFacade = createScriptWorkflowBridge({
    agentTelemetry: modelTelemetry.agentExecution,
    appOptions: options,
    appVersion,
    artifactStore,
    configResult,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    pluginSkillRoots: pluginOutcome.skillRoots,
    bundledSkillRoots,
    prepareUserExecutionBoundary,
    getRuntime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot: env.storageRoot,
    traceContext,
    workingDirectory,
  });

  // workflow run service：CreateWorkflow 的确认窗 Allow 之后真启动引擎的那一侧。
  // journal 窄化失败（store 不带 dwf_* 表）时**不构造**服务——端口保持 undefined，
  // CreateWorkflow 因此回到占位诊断路径。这是一个记了日志的可见降级，而不是一条
  // 会静默丢掉持久化的运行路径（详见 dynamic-workflow-run-service.ts 的文件头）。
  const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
  const dynamicWorkflowRunPort =
    dynamicWorkflowJournal === undefined
      ? undefined
      : createDynamicWorkflowRunService({
          concurrency: workflowConcurrencyGovernor,
          createActorRuntime: async ({
            actor,
            persona,
            pinnedModel,
            runSubagentModel,
            actorModel,
            subagentPermissionMode,
            sessionId: actorSessionId,
            submitPort,
            submitProfile,
            escalatePort,
            modelRequestAdmission,
          }) => {
            const parentRuntime = getRuntime();
            const initialContextSourceSnapshot =
              await parentRuntime.getAcceptedContextSourceSnapshot(traceContext);
            return createScriptWorkflowAgentRuntime({
              childSessionId: actorSessionId,
              initialContextSourceSnapshot,
              configOverrides: {
                // persona 的身份（有效名 + system）→ context builder 的工作流子代理路径。
                // 匿名 / 无 system 时字段缺席，builder 据此省略 named 从句与 persona 段。
                workflowActor: {
                  ...(persona.name === undefined ? {} : { name: persona.name }),
                  ...(persona.system === undefined ? {} : { persona: persona.system }),
                },
                // actor 的工具面是减法（全集减去 plan 与越权的元工具），只能经 configOverrides
                // 表达（request.opts.tools 只有 allowlist）。
                ...workflowActorToolPolicy(),
                // 权限面：子代理跑发起会话的权限模式（plan 除外），未记录即 YOLO
                // （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
                ...workflowActorPermissionPolicy(subagentPermissionMode),
                // 模型面：`runSubagentModel` 是本 run 自己的选择（`subagent_model`），在场时整条
                // 覆盖，排在 pin 之上——主代理不受它影响。没有它也没有 pin 就不覆盖——child runtime
                // 的基线本就是父会话当前模型（工厂的基线，见 script-workflow-child-runtime.ts）。
                // resume 带来的 pin 钉住上一次实际跑的模型（persona 冻结不变式的持久化那一半，见
                // workflow-actor-model.ts 的优先级表）；parentSelection 取父会话**当前**的选择，
                // 与工厂基线同源，pin 比对才不会漂移。
                ...workflowActorModelPolicy(
                  {
                    parentSelection: getRuntime().getSessionModelSelection(),
                    ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                    // persona 点名的模型（脚本里的 `agent(…, { model })`）排在 run 选择之上。
                    ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                  },
                  pinnedModel,
                ).configOverrides,
              },
              deps: {
                agentTelemetry: modelTelemetry.agentExecution,
                appOptions: options,
                appVersion,
                artifactStore,
                configResult,
                fileSystemPort,
                httpClientPort,
                imageProcessorPort,
                logger,
                mcpPort,
                // 父会话的 model factory：actor 与主 turn 从同一份 Registry 视图造 Model，
                // 不各自冻结一份。
                modelFactory,
                permissionService,
                pluginSkillRoots: pluginOutcome.skillRoots,
                bundledSkillRoots,
                runtime: parentRuntime,
                capabilityInstallPort: parentRuntime.getCapabilityInstallPort(),
                runtimeConfig,
                sessionId,
                sessionStore,
                storageRoot: env.storageRoot,
                workingDirectory,
              },
              // persona 不再经 request.opts.systemPrompt 整段替换子代理的系统提示，而是经
              // workflowActor 叠加到基座之上。
              // request 在这里只是工厂签名的占位：opts 为空即「不覆盖任何东西」。
              request: { opts: {} } as never,
              // 权限窗的来源徽标点名这个子代理：`<persona 名> (<siteId>@<ordinal>)`。
              interactionDescription: workflowActorInteractionDescription({ actor, persona }),
              // 子代理的 Browser Use：父会话的端口，由工厂经 forChildSession 派生子端口（tab 归属是
              // actor 自己的 sessionId）。actor runtime 在 run dispose 时 closeBrowserSession，
              // 那一步连 tab 一起关并撤销登记（dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
              ...(browserControlPort === undefined ? {} : { browserControlPort }),
              traceContext,
              // submit profile → submit_result 形态：
              // `untyped` 不注入端口（core 的注册门是端口在场，于是没有这个工具——全 untyped 的子代理
              // 本来就无处可提交）；`mono` 注入端口 + typed 声明；`generic` 只注入端口（通用声明）。
              ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
              // 展开：dwf 的 JsonSchema 是无索引签名的 interface，contracts 的是 Record；
              // 字面量展开拿到隐式索引签名，不必在两包之间造一个转换函数。
              ...(submitProfile.kind === "mono"
                ? { workflowSubmitSchema: { ...submitProfile.schema } }
                : {}),
              // 升级端口与 submit 端口同进同出：两者都是 actor 会话的控制通道，而端口在场
              // 就是 core 侧的注册门。恒传（端口在 run service 里恒被构造），不做 opt-in——
              // 最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
              workflowEscalatePort: escalatePort,
              // 请求级准入端口：driver 在治理器在场时给出，runner 每次尝试先过闸门。
              ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
            });
          },
          // 边界记账与转录截断都读写 actor 会话的消息，走的必须是同一个 store。
          actorTranscriptStore: sessionStore,
          // 用户面产物的字节落点：与主会话、workflow 子
          // 代理共用同一个 tool-artifact store，产物因此和别的大结果落在同一棵目录树下。
          artifactStore,
          executionPort,
          fileSystemPort,
          journal: dynamicWorkflowJournal,
          logger,
          // 进度投影的接缝：一条引擎事件 → 一条父会话的会话事件 → v4 的 workflowRuns 状态键。
          // 走 runtime 的 append 链路（而不是直接推 eventSink）是必需的：只有它同时做持久化、
          // 补 sequenceNumber 与扇出，冷恢复与 replayable 重连因此免费。
          //
          // 身份闸门、runtime 未就绪与 append 失败三条降级路径都在这个汇里（连同它们的单测），
          // 见 dynamic-workflow-run-progress-sink.ts 的文件头。
          onRunEvent: createDynamicWorkflowRunProgressSink({
            // 惰性：run service 在 runtime 构造之前就建好了（它是 AgentRuntime 的依赖之一）。
            getRuntime,
            logger,
            sessionId,
          }),
          // 孤儿收敛的作用域：本 app 的会话。构造时把**这个会话**留在 journal 里的非终态
          // run（死进程的遗物）收敛成 failed；兄弟会话的在飞 run 因此绝不会被误伤。
          parentSessionId: sessionId,
          // 补全落在没有草稿的 run 上时铸草稿（docs/dynamic-workflow/launch.md「The draft after a
          // fill」）：内联规则只在工具层有一份实现，这里注入而不是让 run service 复制它。
          writeWorkflowDraft,
          // 建 run 那一刻会话的权限模式（记进 run-launched，子代理随之）。
          // 惰性同 onRunEvent：启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
          permissionMode: () => getRuntime().getMode(),
          // 在飞的引擎把本会话钉成常驻。2026-09-15 的 bug：引擎不进 runtime task registry，
          // 常驻池把带着在飞 run 的 App 按 idle（10 分钟）关掉，resume 又起了第二个引擎。
          // 惰性取 runtime 同 onRunEvent：run service 是 AgentRuntime 的依赖，构造更早；
          // 而启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
          registerResidencyBlockingWork: (work) => {
            void getRuntime().trackResidencyBlockingWork(work);
          },
          // 发起锚点：CreateWorkflow 在父会话的活动轮里执行，
          // 那一轮的 inputId 就是子代理 agent_step 要挂的 message。trace.turnId 对不上活动轮
          // （理论上不该发生）就交回 submit 侧兜底铸值，绝不把别的轮的 id 记成锚点。
          resolveLaunchInputId: (trace) => {
            const active = getRuntime().getActiveTurnInfo();
            return active !== undefined && active.turnId === trace.turnId
              ? active.inputId
              : undefined;
          },
          ...(isDynamicWorkflowTaskLinkStore(sessionStore)
            ? { taskLinkStore: sessionStore }
            : {}),
        });
  // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
  // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
  // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
  const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
    executionPort,
    fileSystemPort,
    logger,
  });
  // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
  const modelCatalogPort = createModelCatalogPort({
    registry: options.providerRegistry,
    currentSelection: () => getRuntime().getSessionModelSelection(),
  });
  // Определения читаются на каждом turn и после factory/plugin refresh. В Host-режиме
  // источник — snapshot Host; в обычном CLI — файлы .zcode/agents и текущий plugin catalog.
  const loadCurrentAgentDefinitions: NonNullable<
    AgentRuntimeDeps["reloadAgentDefinitions"]
  > = async (input) => {
    const pluginProfilesFor = (
      reservedNames: readonly string[],
      overrides: PluginSubagentModelSelectionOverrides,
    ) => {
      const plugins = pluginCatalog.current().plugins;
      return resolvePluginAgentProfiles(
        {
          logger,
          plugins,
          reservedProfileNames: reservedNames,
          modelSelectionOverrides: overrides,
        },
        loadPluginAgentTemplates({ logger, plugins }),
      ).profiles;
    };
    if (options.readSubagentRuntimeConfig) {
      const snapshot = await options.readSubagentRuntimeConfig(input);
      const parsed = subagentProfilesFromSnapshot(snapshot);
      const pluginProfiles =
        snapshot.kind === "built-in-fallback"
          ? []
          : pluginProfilesFor(
              parsed.profiles.map((profile) => profile.name),
              parsed.pluginAgentModelSelectionOverrides,
            );
      return {
        activeAgents: normalizeAgentProfiles(
          [
            ...(options.runtimeConfig?.subagents?.profiles ?? []),
            ...parsed.profiles,
            ...pluginProfiles,
          ],
          {
            builtInModelSelectionOverrides: {
              ...parsed.builtInModelSelectionOverrides,
              ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
            },
          },
        ),
      };
    }
    const parsed = await loadZCodeAgentProfiles({
      logger,
      storageRoot: env.storageRoot,
      workingDirectory,
      additionalDirectories: options.additionalDirectories,
    });
    const pluginProfiles = pluginProfilesFor(
      parsed.profiles.map((profile) => profile.name),
      parsed.pluginAgentModelSelectionOverrides,
    );
    return {
      activeAgents: normalizeAgentProfiles(
        [
          ...(options.runtimeConfig?.subagents?.profiles ?? []),
          ...parsed.profiles,
          ...pluginProfiles,
        ],
        {
          builtInModelSelectionOverrides: {
            ...parsed.builtInModelSelectionOverrides,
            ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
          },
        },
      ),
    };
  };

  let pluginRefreshPromise: Promise<PluginRuntimeActivationResult> | undefined;
  const refreshPluginComponents = (): Promise<PluginRuntimeActivationResult> => {
    if (pluginRefreshPromise) return pluginRefreshPromise;
    pluginRefreshPromise = (async () => {
      const previous = pluginCatalog.current();
      const next = await pluginCatalog.refresh();
      // Переподключаем только delta. Ранее уже failed plugin server (например,
      // image-search без official trust registry) не должен превращать установку
      // другого плагина в requiresReload.
      const connectMcpServers = Object.fromEntries(
        Object.entries(next.mcpServers).filter(
          ([name, config]) =>
            previous.mcpServers[name] === undefined ||
            !isDeepStrictEqual(previous.mcpServers[name], config),
        ),
      );
      return await getRuntime().applyPluginRuntime({
        mcpServers: next.mcpServers,
        connectMcpServers,
        previousPluginMcpServerNames: Object.keys(previous.mcpServers),
        preservedMcpServerNames: Object.keys(configResult.config.mcp?.servers ?? {}),
        pluginReferenceCatalog: buildPluginReferenceCatalog(next.plugins),
        reloadAgentDefinitions: true,
        signal: new AbortController().signal,
        traceContext,
      });
    })().finally(() => {
      pluginRefreshPromise = undefined;
    });
    return pluginRefreshPromise;
  };

  const runtime = new AgentRuntime(sessionId, runtimeConfig, {
    // Один реестр работ на процесс CLI: journal общий, writer один.
    workLedger: getProcessWorkLedger(),
    // Host по-прежнему обновляет определения на каждом turn. В обычном CLI
    // per-turn reload не нужен; явный reload используется factory/plugin refresh.
    ...(options.readSubagentRuntimeConfig
      ? { loadAgentDefinitions: loadCurrentAgentDefinitions }
      : {}),
    reloadAgentDefinitions: loadCurrentAgentDefinitions,
    agentTelemetry: modelTelemetry.agentExecution,
    // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
    modelRequestAdmission: workflowConcurrencyGovernor.observer(),
    backgroundModelRequestAdmission: workflowConcurrencyGovernor.background(),
    eventStore: options.eventStore ?? createInMemorySessionEventStore(),
    sessionStore,
    sessionMailboxPort,
    logger,
    executionPort,
    // Причина: без этого порта инструмент PtySession исключается из реестра
    // (`includePtySession`), и модель не видит его в списке инструментов хода.
    ptySessionPort,
    workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
    workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
    browserControlPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    artifactStore,
    contextSourcePort:
      options.contextSourcePort ??
      createNodeContextSourceAdapter({
        env: options.env,
        bundledHarnessRulesDirectory: bundledSkillRoots[0]
          ? join(dirname(bundledSkillRoots[0].path), "rules")
          : undefined,
      }),
    skillPort:
      configResult.config.features.skill && configResult.config.skills.enabled
        ? (options.skillPort ??
          createNodeSkillAdapter({
            additionalDirectories: options.additionalDirectories,
            extraRoots: configResult.config.skills.roots,
            extraResolvedRoots: bundledSkillRoots,
            getExtraResolvedRoots: () => pluginCatalog.current().skillRoots,
            disabledPaths: [
              ...collectDisabledPaths(configResult.config.skillOverrides),
              // 动态工作流关闭时不提供 dynamic-workflows 技能：
              // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
              ...(runtimeConfig.dynamicWorkflowEnabled === false
                ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                : []),
            ],
          }))
        : undefined,
    capabilityInstallPort: createCapabilityInstallPort({
      configResult,
      env: options.env,
      logger,
      mcpPort,
      officialPluginRoots: options.officialPluginRoots,
      onPluginInstalled: refreshPluginComponents,
      pluginStorageRoot: options.pluginStorageRoot ?? getPluginStorageRoot(env.cliStorageRoot),
      workingDirectory,
    }),
    mcpPort,
    eventSink: options.eventSink,
    onOffPeakLifecycleEvent: options.onOffPeakLifecycleEvent
      ? (event) => options.onOffPeakLifecycleEvent!({ ...event, sessionId })
      : undefined,
    modelFactory,
    modelFacts,
    providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
    resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
    isRemoteWorkspace: () =>
      isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
    permissionBroker: options.permissionBroker,
    permissionService,
    workflowPort: scriptWorkflowFacade.workflowPort,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    modelCatalogPort,
    automationPort: options.automationPort,
    offPeakPort: options.offPeakPort,
    topicResourcePort: options.topicResourcePort,
    codeIntelligencePort: options.codeIntelligencePort,
    appVersion,
    traceContext,
  });
  state.runtime = runtime;
  markRuntimeConstructed({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    sessionId,
    startupTimer: deps.startupTimer,
  });
  completeAppStartup({
    sessionId,
    startupTimer: deps.startupTimer,
    workingDirectory,
  });
  scheduleStartupLogRetentionCleanup(deps.loggerFactory, logger);
  return {
    runtime,
    scriptWorkflowFacade,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    modelCatalogPort,
    refreshPluginComponents,
  };
}
