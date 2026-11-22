import type { ReactNode } from "react";
export { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
export type { AgentSummary } from "@zcode/shared";
export type {
  CodeIntelligenceService,
  CodeGraphOverview,
  CodeGraphNode,
  CodeImpactResult,
  CodeIndexStatus,
  CodeSearchResult,
  CodeSymbolContext,
  CodeTraceResult,
  CodeWorkspaceRef,
  EmbeddingProvider,
} from "@zcode/services";

export interface AgentWorkbenchViewProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceName?: string;
  remoteSessionId?: string;
  /** Existing conversation-owned projection of the active task's child-agent lineage. */
  runActivity?: ReactNode;
}
