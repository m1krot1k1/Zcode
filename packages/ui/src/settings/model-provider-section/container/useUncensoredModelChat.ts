import { useCallback, useState } from "react";

export interface UncensoredModelChatWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface UncensoredModelChatPort {
  sendMessage(
    workspace: UncensoredModelChatWorkspaceRef,
    input: { providerId: string; modelId: string; text: string },
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export interface UncensoredModelChatTarget {
  providerUid: string;
  modelUid: string;
}

export interface UncensoredModelChatState {
  target: UncensoredModelChatTarget | null;
  text: string;
  busy: boolean;
  result: { ok: boolean; text: string } | null;
  setText: (value: string) => void;
  start: (providerUid: string, modelUid: string) => void;
  close: () => void;
  send: (providerId: string, modelId: string) => Promise<void>;
}

/**
 * Локальный чат с одной uncensored-моделью. Ключ и HTTP-вызов остаются на Host;
 * hook владеет только черновиком, состоянием отправки и последним ответом.
 */
export function useUncensoredModelChat(
  port: UncensoredModelChatPort | null | undefined,
  workspaceRef: UncensoredModelChatWorkspaceRef | undefined,
): UncensoredModelChatState {
  const [target, setTarget] = useState<UncensoredModelChatTarget | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const start = useCallback((providerUid: string, modelUid: string) => {
    setTarget({ providerUid, modelUid });
    setText("");
    setResult(null);
  }, []);

  const close = useCallback(() => {
    setTarget((current) => {
      if (!current || busy) return current;
      setResult(null);
      return null;
    });
  }, [busy]);

  const send = useCallback(
    async (providerId: string, modelId: string) => {
      if (!port || !workspaceRef || busy) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setBusy(true);
      setResult(null);
      try {
        const next = await port.sendMessage(workspaceRef, {
          providerId,
          modelId,
          text: trimmed,
        });
        setResult(next.ok ? { ok: true, text: next.text } : { ok: false, text: next.error });
      } catch (error: unknown) {
        setResult({
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, port, text, workspaceRef],
  );

  return { target, text, busy, result, setText, start, close, send };
}
