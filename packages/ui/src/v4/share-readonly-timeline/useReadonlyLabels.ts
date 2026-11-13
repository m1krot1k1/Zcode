import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";

export function useReadonlyLabels(): ReadonlyLabels {
  const { intl } = useZCodeIntl();
  return {
    history: intl.formatMessage({ id: "conversationShare.readonly.history" }),
    computerUse: intl.formatMessage({
      id: "conversationShare.readonly.computerUse",
    }),
    explore: intl.formatMessage({ id: "conversationShare.readonly.explore" }),
    execute: intl.formatMessage({ id: "conversationShare.readonly.execute" }),
    changes: intl.formatMessage({ id: "conversationShare.readonly.changes" }),
    artifactPreview: intl.formatMessage({
      id: "conversationShare.readonly.artifactPreview",
    }),
    markerCompact: intl.formatMessage({
      id: "conversationShare.readonly.markerCompact",
    }),
    markerModelChange: intl.formatMessage({
      id: "conversationShare.readonly.markerModelChange",
    }),
    unsupportedRows: intl.formatMessage({
      id: "conversationShare.readonly.unsupportedRows",
    }),
  };
}
