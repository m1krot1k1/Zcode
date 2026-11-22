import { ConversationShareServiceError } from "../conversationShare.js";

export function throwProjectionError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
  diagnostics?: { rowKind?: string; rowId?: number; field?: string },
): never {
  throw new ConversationShareServiceError(kind, message, { diagnostics });
}
