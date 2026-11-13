/**
 * Automations 闲时任务的提交与历史清理动作。
 *
 * 与 `useAutomationActionHandlers` 拆开是为了让删除的破坏性确认留在
 * `AutomationsSection.tsx`，同时保持原有 `useCallback` 调用顺序。
 */
import { useCallback } from "react";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";
import {
  resolveOffPeakCreateErrorMessageId,
  useOffPeakTaskStore,
} from "@/store/offPeakTaskStore.js";
import type { OffPeakEditSubmit } from "@/settings/OffPeakEditView.js";
import { toast } from "@/settings/automations-section/automationsSectionToast.js";
import type { useAutomationNavigationEffects } from "@/settings/automations-section/useAutomationNavigationEffects.js";
import type { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";

export interface UseAutomationOffPeakActionHandlersParams {
  state: ReturnType<typeof useAutomationsDashboardState>;
  navigation: ReturnType<typeof useAutomationNavigationEffects>;
}

export function useAutomationOffPeakActionHandlers({
  state,
  navigation,
}: UseAutomationOffPeakActionHandlersParams) {
  const {
    intl,
    view,
    offPeakCreateGrey,
    offPeakTaskService,
    offPeakDeleteHistory,
    offPeakCreate,
    offPeakUpdate,
    platform,
  } = state;
  const { showCodingPlanRequiredToast } = navigation;
  const handleOffPeakDeleteHistory = useCallback(
    async (task: ZCodeOffPeakTask) => {
      await offPeakDeleteHistory(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [offPeakDeleteHistory, offPeakTaskService],
  );

  const handleOffPeakSubmit = useCallback(
    async (input: OffPeakEditSubmit) => {
      const current = view;
      const telemetrySnapshot =
        current.mode === "offpeak-create"
          ? freezeOffPeakCreateTelemetrySnapshot({
              source: current.draft?.telemetrySource,
              model: input.modelSelection.modelId,
              providerId: input.modelSelection.providerId,
            })
          : null;
      if (current.mode !== "offpeak-edit" && offPeakCreateGrey.reason !== null) {
        if (offPeakCreateGrey.reason === "plan") {
          showCodingPlanRequiredToast();
        } else if (offPeakCreateGrey.reason === "unavailable") {
          toast(intl.formatMessage({ id: "offPeak.error.unavailable" }));
        } else {
          toast(offPeakCreateGrey.tooltip ?? intl.formatMessage({ id: "offPeak.error.quota" }));
        }
        if (telemetrySnapshot) {
          void reportOffPeakCreateResult(platform, telemetrySnapshot, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "",
            providerName: "",
          });
        }
        return false;
      }
      if (current.mode === "offpeak-edit") {
        const updated = await offPeakUpdate(
          current.task.offPeakTaskId,
          {
            title: input.title,
            prompt: input.prompt,
            permissionMode: input.permissionMode,
            modelSelection: input.modelSelection,
          },
          offPeakTaskService,
        );
        if (!updated) {
          toast(intl.formatMessage({ id: "offPeak.error.generic" }));
        }
        return updated;
      }

      const result =
        telemetrySnapshot !== null
          ? await createAndReportOffPeakTask(platform, telemetrySnapshot, () =>
              offPeakCreate(input, offPeakTaskService),
            )
          : await offPeakCreate(input, offPeakTaskService);
      if (!result.ok) {
        toast(
          intl.formatMessage({
            id: resolveOffPeakCreateErrorMessageId(result),
          }),
        );
      }
      return result.ok;
    },
    [
      intl,
      offPeakCreate,
      offPeakCreateGrey,
      offPeakTaskService,
      offPeakUpdate,
      platform,
      showCodingPlanRequiredToast,
      view,
    ],
  );
  return {
    handleOffPeakDeleteHistory,
    handleOffPeakSubmit,
  };
}
