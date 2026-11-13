import { TID_CHAT_MODEL_SELECT_ITEM, TID_CHAT_MODEL_SELECT_TRIGGER } from "@zcode/shared/test-ids";

import { DEFAULT_WORKSPACE, readModelProvider } from "../desktop-app.js";
import { UPSTREAM_PROVIDER_ID } from "./config.js";

export async function collectModelDropdownDiagnostics(
  attemptedTestIds: string[],
  providerId = UPSTREAM_PROVIDER_ID,
) {
  const provider = await readModelProvider(providerId);
  const dom = await browser.execute(
    (modelItemPrefix, triggerTestId, defaultWorkspace) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${modelItemPrefix}"]`),
      ).map((element) => ({
        testId: element.dataset.testid ?? "",
        text: element.innerText.trim(),
        value: element.getAttribute("value"),
        selected: element.getAttribute("data-model-option-selected"),
        locked: element.getAttribute("data-model-option-locked"),
      }));
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            getWorkspaceState?: (
              workspacePath: string,
              workspaceIdentity?: string,
            ) => {
              activeTaskId?: string | null;
              configOptions?: Array<{
                category?: string;
                currentValue?: unknown;
                id?: string;
                options?: Array<{ value?: string; name?: string }>;
                type?: string;
              }> | null;
              configOptionsStatus?: string;
              draftSessionId?: string | null;
              isGhostSupplier?: boolean;
              modelSwitchPending?: boolean;
              modelSwitchRequestId?: string | null;
              modelSwitchStage?: string;
              selectedProvider?: string;
              selectedSupplierKey?: string;
              supplierMismatchReason?: string | null;
              taskConfigOptionsByTaskId?: Record<
                string,
                Array<{
                  category?: string;
                  currentValue?: unknown;
                  id?: string;
                  options?: Array<{ value?: string; name?: string }>;
                  type?: string;
                }>
              >;
            };
            workspaces?: Record<string, unknown>;
          };
        };
      };
      const storeState = e2eWindow.__zcodeSessionStoreE2E?.getState();
      const workspaceState = storeState?.getWorkspaceState?.(defaultWorkspace);
      const selectSummary = (
        options:
          | Array<{
              category?: string;
              currentValue?: unknown;
              id?: string;
              options?: Array<{ value?: string; name?: string }>;
              type?: string;
            }>
          | null
          | undefined,
      ) =>
        (options ?? [])
          .filter((option) =>
            ["model", "mode", "thought_level"].includes(option.category ?? option.id ?? ""),
          )
          .map((option) => ({
            category: option.category ?? null,
            currentValue:
              typeof option.currentValue === "string"
                ? option.currentValue
                : (option.currentValue ?? null),
            id: option.id ?? null,
            optionValues: (option.options ?? []).map((candidate) => candidate.value ?? ""),
            type: option.type ?? null,
          }));
      const activeTaskId = workspaceState?.activeTaskId ?? null;
      const taskConfigOptions =
        activeTaskId && workspaceState?.taskConfigOptionsByTaskId
          ? (workspaceState.taskConfigOptionsByTaskId[activeTaskId] ?? null)
          : null;

      return {
        bodyText: document.body?.innerText?.slice(0, 1200) ?? "",
        itemCount: items.length,
        items,
        store: workspaceState
          ? {
              activeTaskId,
              configOptions: selectSummary(workspaceState.configOptions),
              configOptionsStatus: workspaceState.configOptionsStatus ?? null,
              draftSessionId: workspaceState.draftSessionId ?? null,
              isGhostSupplier: workspaceState.isGhostSupplier ?? null,
              modelSwitchPending: workspaceState.modelSwitchPending ?? null,
              modelSwitchRequestId: workspaceState.modelSwitchRequestId ?? null,
              modelSwitchStage: workspaceState.modelSwitchStage ?? null,
              selectedProvider: workspaceState.selectedProvider ?? null,
              selectedSupplierKey: workspaceState.selectedSupplierKey ?? null,
              supplierMismatchReason: workspaceState.supplierMismatchReason ?? null,
              taskConfigOptions: selectSummary(taskConfigOptions),
              workspaceKeys: Object.keys(storeState?.workspaces ?? {}),
            }
          : {
              available: Boolean(storeState),
              reason: storeState ? "workspace-state-missing" : "store-bridge-missing",
              workspaceKeys: Object.keys(storeState?.workspaces ?? {}),
            },
        triggerText: trigger?.innerText.trim() ?? "",
        url: window.location.href,
      };
    },
    TID_CHAT_MODEL_SELECT_ITEM,
    TID_CHAT_MODEL_SELECT_TRIGGER,
    DEFAULT_WORKSPACE,
  );

  return {
    attemptedTestIds,
    dom,
    provider: provider
      ? {
          id: provider.id,
          name: provider.name,
          apiKeyLength: provider.apiKey.trim().length,
          enabled: provider.enabled,
          endpoints: provider.endpoints,
          models: provider.models,
          source: provider.source,
        }
      : null,
  };
}
