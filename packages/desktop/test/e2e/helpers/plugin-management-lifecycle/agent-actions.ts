import {
  type ZCodePluginsInstallResult,
  type ZCodePluginsListResult,
  type ZCodePluginsMarketplaceMutationResult,
  type ZCodePluginsOverviewResult,
  type ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import type { PluginTestActionName, SerializedActionResult } from "./types.js";

export async function getPluginOverview(
  workspacePath = DEFAULT_WORKSPACE,
  configScope?: "user" | "workspace",
): Promise<ZCodePluginsOverviewResult> {
  return callPluginTestAction("getPluginsOverview", {
    workspacePath,
    ...(configScope ? { configScope } : {}),
  });
}

export async function addMarketplaceSourceThroughAgent(
  source: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  return callPluginTestAction("addPluginMarketplace", {
    source,
    workspacePath,
  });
}

export async function updateMarketplaceThroughAgent(
  marketplace: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  return callPluginTestAction("updatePluginMarketplace", {
    marketplace,
    workspacePath,
  });
}

export async function installMarketplacePluginThroughAgent(
  pluginName: string,
  marketplace: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsInstallResult> {
  return callPluginTestAction("installPlugin", {
    marketplace,
    pluginName,
    scope: "user",
    workspacePath,
  });
}

export async function getPluginList(
  workspacePath = DEFAULT_WORKSPACE,
  workspaceIdentity?: string,
  configScope?: "user" | "workspace",
): Promise<ZCodePluginsListResult> {
  return callPluginTestAction("listPlugins", {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(configScope ? { configScope } : {}),
  });
}

export async function getPluginReferenceCatalog(
  options: {
    sessionId?: string;
    workspaceIdentity?: string;
    workspacePath?: string;
  } = {},
): Promise<ZCodePluginsReferenceCatalogResult> {
  return callPluginTestAction("getPluginReferenceCatalog", {
    workspacePath: options.workspacePath ?? DEFAULT_WORKSPACE,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
}

export async function waitUntilPluginOverview(
  predicate: (overview: ZCodePluginsOverviewResult) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await getPluginOverview()), {
    timeout,
    timeoutMsg,
  });
}

export async function waitUntilPluginList(
  predicate: (list: ZCodePluginsListResult) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await getPluginList()), {
    timeout,
    timeoutMsg,
  });
}

export async function waitForPluginDraftRuntimeInvalidation(
  workspacePath = DEFAULT_WORKSPACE,
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((path) => {
        const store = (
          window as typeof window & {
            __zcodeSessionStoreE2E?: {
              getState: () => {
                getWorkspaceState: (workspacePath: string) => {
                  draftSessionId: string | null;
                };
              };
            };
          }
        ).__zcodeSessionStoreE2E;
        return store?.getState().getWorkspaceState(path).draftSessionId === null;
      }, workspacePath),
    {
      timeout,
      timeoutMsg: "Plugin runtime refresh did not invalidate the deferred draft session",
    },
  );
}

async function callPluginTestAction<T>(
  actionName: PluginTestActionName,
  params: unknown,
): Promise<T> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (name) =>
          typeof (
            window as typeof window & {
              __testActions?: Record<string, unknown>;
            }
          ).__testActions?.[name] === "function",
        actionName,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `plugin test action did not become ready: ${actionName}`,
    },
  );
  const result = (await browser.executeAsync(
    (
      name: PluginTestActionName,
      input: unknown,
      done: (result: SerializedActionResult<unknown>) => void,
    ) => {
      const actions = (
        window as typeof window & {
          __testActions?: Record<string, unknown>;
        }
      ).__testActions;
      const action = actions?.[name];
      if (typeof action !== "function") {
        done({ ok: false, error: `missing test action: ${name}` });
        return;
      }
      Promise.resolve((action as (value: unknown) => Promise<unknown>)(input))
        .then((value) => done({ ok: true, value }))
        .catch((error: unknown) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    actionName,
    params,
  )) as SerializedActionResult<unknown>;
  if (!result.ok) throw new Error(result.error ?? `test action failed: ${actionName}`);
  return result.value as T;
}
