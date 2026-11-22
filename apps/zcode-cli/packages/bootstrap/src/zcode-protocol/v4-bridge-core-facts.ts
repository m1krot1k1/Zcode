// coreHost 持久副作用面：shared context 丢弃与无 user message 命令的查重事实。
import type { SessionId } from "@zcode/contracts";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { savePersistentCommandFact } from "../zcode-protocol-v4/persistent-command-facts.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createFactsCoreHost(
  state: BridgeState,
): Pick<V4CommandCoreHost, "discardSharedContext" | "recordPersistentCommandFact"> {
  const { context, persistentCommands } = state;
  return {
    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      if (!store?.transitionSharedContextImport) return false;
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
  };
}
