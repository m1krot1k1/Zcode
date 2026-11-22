import type { Server } from "node:http";
import type { ClientScenesMockServer } from "../helpers/client-scenes-mock-server.js";
import type { CodingPlanUpgradeMockServer } from "../helpers/coding-plan-upgrade-mock-server.js";
import type { DynamicWorkflowConfigMockServer } from "../helpers/dynamic-workflow-config-mock-server.js";
import type { ModelContextBudgetConfigMockServer } from "../helpers/model-context-budget-config-mock-server.js";
import type { E2ENetworkCaptureProxy } from "../helpers/network-capture-proxy.js";
import type { PluginCdnZipFixtureServer } from "../helpers/plugin-cdn-zip-marketplace.js";
import type { UpstreamReplayServer } from "../helpers/upstream-replay-server.js";
import type { E2EFailureArtifactCollector } from "../reporting/e2e-failure-artifacts.js";

/**
 * Единственное изменяемое состояние WDIO-раннера: mock-серверы, текущий worker и
 * артефакты падений переживают границы модулей, поэтому живут в одном объекте.
 * Инициализация значений, зависящих от env, выполняется в env.ts.
 */
export const wdioState = {
  upstreamCaptureProxy: null as E2ENetworkCaptureProxy | null,
  upstreamReplayServer: null as UpstreamReplayServer | null,
  codingPlanTeamMockServer: null as Server | null,
  codingPlanTeamMockBaseUrl: "" as string,
  codingPlanDataPlaneProxy: null as E2ENetworkCaptureProxy | null,
  codingPlanUpgradeMockServer: null as CodingPlanUpgradeMockServer | null,
  modelContextBudgetConfigMockServer: null as ModelContextBudgetConfigMockServer | null,
  dynamicWorkflowConfigMockServer: null as DynamicWorkflowConfigMockServer | null,
  clientScenesMockServer: null as ClientScenesMockServer | null,
  stopOAuthCompletionRaceFixture: null as (() => Promise<void>) | null,
  stopWebRemoteControlAuthGateFixture: null as (() => Promise<void>) | null,
  stopAccessToken401Fixture: null as (() => Promise<void>) | null,
  pluginCdnZipFixtureServer: null as PluginCdnZipFixtureServer | null,
  upstreamE2EBaseUrl: "" as string,
  e2eRunnerExitWatchdog: null as ReturnType<typeof setTimeout> | null,
  currentE2EElectronAppPid: null as number | null,
  currentE2EWorkerSpecs: [] as string[],
  currentE2EBeforeSessionError: null as unknown,
  e2eFailureArtifacts: null as E2EFailureArtifactCollector | null,
  currentE2EWorkerSessionSpecs: [] as string[],
  currentE2EChromiumUserDataDir: null as string | null,
  e2eWorkerLifecycleStarts: new Map<string, { specs: string[]; startedAt: Date }>(),
  upstreamE2EHttpMode: "" as string,
};
