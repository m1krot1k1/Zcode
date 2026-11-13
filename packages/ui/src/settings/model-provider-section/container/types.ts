import type { SettingsModelProviderTarget } from "@/lib/settingsNavigation.js";
import type { ModelProviderNavGroup } from "../constants.js";

export interface ModelProviderSectionProps {
  workspacePath?: string;
  /** A local-only workspace ref for embeddings; never pass the remote workspace path here. */
  codeIndexWorkspacePath?: string;
  codeIndexWorkspaceIdentity?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
}

export type CodingPlanConnectionNavItem = Extract<
  ModelProviderNavGroup["items"][number],
  { type: "codingPlan" | "teamPlan" }
>;
