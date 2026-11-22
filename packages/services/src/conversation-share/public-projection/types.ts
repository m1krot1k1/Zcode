import type {
  ConversationShareContentBlock,
  ConversationShareArtifactDescriptor,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export interface ConversationSharePublicProjection {
  contentBlocks?: ConversationShareContentBlock[];
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
  artifacts: ConversationSharePublicArtifact[];
}

export interface ConversationSharePublicArtifact {
  sourceRef: string;
  descriptor: ConversationShareArtifactDescriptor;
}
