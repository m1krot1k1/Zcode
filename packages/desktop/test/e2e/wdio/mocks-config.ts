import {
  resolveDynamicWorkflowConfigMockScenario,
  startDynamicWorkflowConfigMockServer,
  applyDynamicWorkflowConfigMockEnv,
  clearDynamicWorkflowConfigMockEnv,
} from "../helpers/dynamic-workflow-config-mock-server.js";
import {
  resolveModelContextBudgetConfigMockScenario,
  startModelContextBudgetConfigMockServer,
} from "../helpers/model-context-budget-config-mock-server.js";
import {
  shouldUseClientScenesMock,
  startClientScenesMockServer,
  applyClientScenesMockEnv,
  clearClientScenesMockEnv,
} from "../helpers/client-scenes-mock-server.js";
import {
  shouldUsePluginCdnZipMarketplaceFixture,
  startPluginCdnZipFixtureServer,
  stopPluginCdnZipFixtureServer,
} from "../helpers/plugin-cdn-zip-marketplace.js";
import { wdioState } from "./state.js";

export async function startModelContextBudgetConfigE2EMock(specs: string[] = []) {
  const scenario = resolveModelContextBudgetConfigMockScenario(specs);
  if (!scenario) {
    await stopModelContextBudgetConfigE2EMock();
    return;
  }
  if (wdioState.modelContextBudgetConfigMockServer?.scenario !== scenario) {
    await stopModelContextBudgetConfigE2EMock();
    wdioState.modelContextBudgetConfigMockServer =
      await startModelContextBudgetConfigMockServer(scenario);
  }
  process.env.ZCODE_BASE_URL = wdioState.modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_TEST_BASE_URL = wdioState.modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_ENDPOINT_ORIGIN = wdioState.modelContextBudgetConfigMockServer.baseUrl;
}

export async function stopModelContextBudgetConfigE2EMock() {
  if (!wdioState.modelContextBudgetConfigMockServer) {
    return;
  }
  await wdioState.modelContextBudgetConfigMockServer.stop();
  wdioState.modelContextBudgetConfigMockServer = null;
  delete process.env.ZCODE_BASE_URL;
  delete process.env.ZCODE_TEST_BASE_URL;
  delete process.env.ZCODE_ENDPOINT_ORIGIN;
}

export async function startDynamicWorkflowConfigE2EMock(specs: string[] = []) {
  const scenario = resolveDynamicWorkflowConfigMockScenario(specs);
  if (!scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    return;
  }
  if (wdioState.dynamicWorkflowConfigMockServer?.scenario !== scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    wdioState.dynamicWorkflowConfigMockServer =
      await startDynamicWorkflowConfigMockServer(scenario);
  }
  applyDynamicWorkflowConfigMockEnv(process.env, wdioState.dynamicWorkflowConfigMockServer.baseUrl);
}

export async function stopDynamicWorkflowConfigE2EMock() {
  if (!wdioState.dynamicWorkflowConfigMockServer) {
    return;
  }
  const baseUrl = wdioState.dynamicWorkflowConfigMockServer.baseUrl;
  await wdioState.dynamicWorkflowConfigMockServer.stop();
  wdioState.dynamicWorkflowConfigMockServer = null;
  clearDynamicWorkflowConfigMockEnv(process.env, baseUrl);
}

export async function startClientScenesE2EMockIfNeeded(specs: string[] = []) {
  if (!shouldUseClientScenesMock(specs)) {
    await stopClientScenesE2EMock();
    return;
  }
  wdioState.clientScenesMockServer ??= await startClientScenesMockServer();
  applyClientScenesMockEnv(process.env, wdioState.clientScenesMockServer.baseUrl);
}

export async function stopClientScenesE2EMock() {
  if (!wdioState.clientScenesMockServer) {
    return;
  }
  const baseUrl = wdioState.clientScenesMockServer.baseUrl;
  await wdioState.clientScenesMockServer.stop();
  wdioState.clientScenesMockServer = null;
  clearClientScenesMockEnv(process.env, baseUrl);
}

export async function startPluginCdnZipFixtureIfNeeded(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  wdioState.pluginCdnZipFixtureServer ??= await startPluginCdnZipFixtureServer();
}

export async function stopPluginCdnZipFixture() {
  await stopPluginCdnZipFixtureServer(wdioState.pluginCdnZipFixtureServer ?? undefined);
  wdioState.pluginCdnZipFixtureServer = null;
}
