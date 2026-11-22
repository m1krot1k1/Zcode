import { afterEach, describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

afterEach(() => {
  vi.doUnmock("../src/zcode-agent/zcodeAgentProcessManager.js");
  vi.resetModules();
});

describe("OpenCode ACP Host reverse RPC", () => {
  it("validates the active CLI client, applies only an advertised model, acknowledges dispatch, and fences stop", async () => {
    const handlers: Array<(request: { id: string; method: string; params?: unknown }) => void> = [];
    const respond = vi.fn(async () => {});
    const respondError = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    const prompt = Promise.withResolvers<{ stopReason: string }>();
    let emitSessionUpdate: ((value: unknown) => void) | undefined;
    let disposed = false;
    const runtime = {
      startSession: vi.fn(async ({ cwd }: { cwd: string }) => ({
        sessionId: "acp-session-1",
        cwd,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "provider/old",
            options: [
              { value: "provider/old", name: "Old" },
              { value: "provider/new", name: "New" },
            ],
          },
        ],
      })),
      setConfigOption: vi.fn(async () => ({
        sessionId: "acp-session-1",
        cwd: "/workspace/a",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "provider/new",
            options: [{ value: "provider/new", name: "New" }],
          },
        ],
      })),
      prompt: vi.fn(() => prompt.promise),
      cancel: vi.fn(async () => {}),
      respondToPermission: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      onDynamicSessionUpdate: vi.fn(() => (listener: (value: unknown) => void) => {
        emitSessionUpdate = listener;
        return { dispose() {} };
      }),
      onDynamicPermissionEvent: vi.fn(() => (_listener: (value: unknown) => void) => ({
        dispose() {},
      })),
    };
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        markReady() {}
        disposeAll() {}
        async disposeAllAndWait() {}
        async getClient() {
          return {
            request: async (_method: string, params: unknown) => params,
            respond,
            respondError,
            notify,
            get isDisposed() {
              return disposed;
            },
            transportKind: "stdio",
            onNotification: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
            onRequest: (handler: (typeof handlers)[number]) => {
              handlers.push(handler);
              return { dispose() {} };
            },
          };
        }
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    const service = createZCodeAgentService({
      openCodeAcpRuntime: runtime as never,
      modelSelectionReadinessSource: {
        getView: async () => offPeakSelectionView(),
      },
    });
    const workspace = {
      workspacePath: "/workspace/a",
      workspaceIdentity: "test:a",
    };
    const invoke = (id: string, params: unknown) =>
      handlers.forEach((handler) =>
        handler({
          id,
          method: zcodeProtocolMethods.interactionRequestOpenCodeAgentRun,
          params,
        }),
      );
    const base = {
      protocolVersion: 1,
      zcodeSessionId: "session-a",
      commandId: "command-a",
      runId: "command-a",
    };
    try {
      await service.initialize(workspace);
      invoke("invalid", {
        ...base,
        operation: "startRun",
        text: "hello",
        model: { kind: "default" },
        cwd: "/tmp/attacker",
      });
      await vi.waitFor(() =>
        expect(respondError).toHaveBeenCalledWith(
          "invalid",
          expect.objectContaining({ code: -32602 }),
        ),
      );
      invoke("start", {
        ...base,
        operation: "startRun",
        text: "hello",
        model: { kind: "catalog", modelId: "provider/new" },
      });
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith("start", {
          status: "accepted",
          opencodeSessionId: "acp-session-1",
        }),
      );
      expect(runtime.startSession).toHaveBeenCalledWith({
        cwd: "/workspace/a",
      });
      expect(runtime.setConfigOption).toHaveBeenCalledWith({
        sessionId: "acp-session-1",
        configId: "model",
        value: "provider/new",
      });
      expect(runtime.prompt).toHaveBeenCalledWith({
        sessionId: "acp-session-1",
        text: "hello",
      });
      expect(notify).toHaveBeenCalledWith(
        zcodeProtocolMethods.interactionOpenCodeAgentRunEvent,
        expect.objectContaining({
          protocolVersion: 1,
          zcodeSessionId: "session-a",
          commandId: "command-a",
          runId: "command-a",
          opencodeSessionId: "acp-session-1",
          sequence: 1,
          event: expect.objectContaining({
            type: "started",
            modelOptionId: "model",
            modelValue: "provider/new",
          }),
        }),
      );
      emitSessionUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
      });
      emitSessionUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second" },
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
      expect(notify.mock.calls.map(([, notification]) => notification)).toEqual([
        expect.objectContaining({
          sequence: 1,
          event: expect.objectContaining({ type: "started" }),
        }),
        expect.objectContaining({ sequence: 2, event: { type: "content", text: "first" } }),
        expect.objectContaining({ sequence: 3, event: { type: "content", text: "second" } }),
      ]);
      expect(prompt).toBeDefined();
      invoke("wrong-stop", {
        ...base,
        operation: "cancelRun",
        opencodeSessionId: "other-session",
      });
      await vi.waitFor(() =>
        expect(respondError).toHaveBeenCalledWith(
          "wrong-stop",
          expect.objectContaining({ code: -32602 }),
        ),
      );
      expect(runtime.cancel).not.toHaveBeenCalled();
      invoke("stop", {
        ...base,
        operation: "cancelRun",
        opencodeSessionId: "acp-session-1",
      });
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith(
          "stop",
          expect.objectContaining({ status: "cancelling" }),
        ),
      );
      expect(runtime.cancel).toHaveBeenCalledWith({
        sessionId: "acp-session-1",
      });
      invoke("status", { ...base, operation: "getRunStatus" });
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith(
          "status",
          expect.objectContaining({
            status: "cancelling",
            opencodeSessionId: "acp-session-1",
          }),
        ),
      );
    } finally {
      disposed = true;
      await service.disposeAllAndWait();
      prompt.resolve({ stopReason: "cancelled" });
    }
  });

  it.each([
    "startSession",
    "setConfigOption",
    "clientDisconnect",
    "serviceDispose",
    "acceptedAck",
  ] as const)(
    "keeps cancellation or teardown attached to the same ACP run during %s",
    async (pendingStage) => {
      const handlers: Array<(request: { id: string; method: string; params?: unknown }) => void> =
        [];
      const closeHandlers: Array<() => void> = [];
      const respond = vi.fn(async () => {});
      const respondError = vi.fn(async () => {});
      const acceptedAck = Promise.withResolvers<void>();
      const pendingPrompt = Promise.withResolvers<{ stopReason: string }>();
      const startSession = Promise.withResolvers<{
        sessionId: string;
        cwd: string;
        configOptions: Array<{
          id: string;
          name: string;
          type: "select";
          currentValue: string;
          options: Array<{ value: string; name: string }>;
        }>;
      }>();
      const setConfigOption = Promise.withResolvers<{
        sessionId: string;
        cwd: string;
        configOptions: Array<{
          id: string;
          name: string;
          type: "select";
          currentValue: string;
          options: Array<{ value: string; name: string }>;
        }>;
      }>();
      const session = {
        sessionId: "acp-session-cancel",
        cwd: "/workspace/cancel",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: "provider/old",
            options: [{ value: "provider/new", name: "New" }],
          },
        ],
      };
      let disposed = false;
      const runtime = {
        startSession: vi.fn(() =>
          pendingStage === "setConfigOption" || pendingStage === "acceptedAck"
            ? Promise.resolve(session)
            : startSession.promise,
        ),
        setConfigOption: vi.fn(() =>
          pendingStage === "setConfigOption"
            ? setConfigOption.promise
            : Promise.resolve({
                ...session,
                configOptions: [{ ...session.configOptions[0]!, currentValue: "provider/new" }],
              }),
        ),
        prompt: vi.fn(() =>
          pendingStage === "acceptedAck"
            ? pendingPrompt.promise
            : Promise.resolve({ stopReason: "end_turn" }),
        ),
        cancel: vi.fn(async () => {}),
        respondToPermission: vi.fn(async () => {}),
        closeSession: vi.fn(async () => {}),
        onDynamicSessionUpdate: vi.fn(() => (_listener: (value: unknown) => void) => ({
          dispose() {},
        })),
        onDynamicPermissionEvent: vi.fn(() => (_listener: (value: unknown) => void) => ({
          dispose() {},
        })),
      };
      vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
        ZCodeAgentProcessManager: class {
          onRuntimeLifecycle() {
            return { dispose() {} };
          }
          onRuntimeRestarted() {
            return { dispose() {} };
          }
          markReady() {}
          disposeAll() {}
          async disposeAllAndWait() {}
          async getClient() {
            return {
              request: async (_method: string, params: unknown) => params,
              respond: vi.fn(async (id: string, result?: { status?: string }) => {
                await respond(id, result);
                if (pendingStage === "acceptedAck" && result?.status === "accepted") {
                  await acceptedAck.promise;
                }
              }),
              respondError,
              notify: vi.fn(async () => {}),
              get isDisposed() {
                return disposed;
              },
              transportKind: "stdio",
              onNotification: () => ({ dispose() {} }),
              onClose: (handler: () => void) => {
                closeHandlers.push(handler);
                return { dispose() {} };
              },
              onRequest: (handler: (typeof handlers)[number]) => {
                handlers.push(handler);
                return { dispose() {} };
              },
            };
          }
        },
      }));
      const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
      const service = createZCodeAgentService({
        openCodeAcpRuntime: runtime as never,
        modelSelectionReadinessSource: {
          getView: async () => offPeakSelectionView(),
        },
      });
      const workspace = {
        workspacePath: "/workspace/cancel",
        workspaceIdentity: "test:cancel",
      };
      const base = {
        protocolVersion: 1,
        zcodeSessionId: "session-cancel",
        commandId: "command-cancel",
        runId: "command-cancel",
      };
      let serviceDisposePromise: Promise<void> | undefined;
      let serviceDisposeSettled = false;
      const invoke = (id: string, params: unknown) =>
        handlers.forEach((handler) =>
          handler({
            id,
            method: zcodeProtocolMethods.interactionRequestOpenCodeAgentRun,
            params,
          }),
        );

      try {
        await service.initialize(workspace);
        invoke("start", {
          ...base,
          operation: "startRun",
          text: "do not run after cancellation",
          model: { kind: "catalog", modelId: "provider/new" },
        });
        await vi.waitFor(() => expect(runtime.startSession).toHaveBeenCalledTimes(1));
        if (pendingStage === "clientDisconnect") {
          disposed = true;
          closeHandlers.forEach((handler) => handler());
        } else if (pendingStage === "serviceDispose") {
          serviceDisposePromise = service.disposeAllAndWait().then(() => {
            serviceDisposeSettled = true;
          });
          invoke("late-start", {
            ...base,
            commandId: "command-late",
            runId: "command-late",
            operation: "startRun",
            text: "must not outlive teardown",
            model: { kind: "default" },
          });
          await Promise.resolve();
          expect(serviceDisposeSettled).toBe(false);
          await vi.waitFor(() => expect(respondError).toHaveBeenCalledTimes(1));
          expect(runtime.startSession).toHaveBeenCalledTimes(1);
        } else if (pendingStage === "acceptedAck") {
          await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(1));
          serviceDisposePromise = service.disposeAllAndWait().then(() => {
            serviceDisposeSettled = true;
          });
          await Promise.resolve();
          expect(serviceDisposeSettled).toBe(false);
          acceptedAck.resolve();
        }
        if (pendingStage === "setConfigOption") {
          startSession.resolve(session);
          await vi.waitFor(() => expect(runtime.setConfigOption).toHaveBeenCalledTimes(1));
        }

        if (
          pendingStage !== "clientDisconnect" &&
          pendingStage !== "serviceDispose" &&
          pendingStage !== "acceptedAck"
        ) {
          invoke("cancel", {
            ...base,
            operation: "cancelRun",
            ...(pendingStage === "setConfigOption" ? { opencodeSessionId: session.sessionId } : {}),
          });
          await vi.waitFor(() =>
            expect(respond.mock.calls.length + respondError.mock.calls.length).toBeGreaterThan(0),
          );
          expect(respondError).not.toHaveBeenCalled();
          expect(respond).toHaveBeenCalledWith(
            "cancel",
            expect.objectContaining({ status: "cancelling" }),
          );
        }

        if (
          pendingStage === "startSession" ||
          pendingStage === "clientDisconnect" ||
          pendingStage === "serviceDispose"
        ) {
          startSession.resolve(session);
        } else {
          setConfigOption.resolve({
            ...session,
            configOptions: [{ ...session.configOptions[0]!, currentValue: "provider/new" }],
          });
        }
        if (pendingStage === "acceptedAck") {
          await expect(serviceDisposePromise).resolves.toBeUndefined();
          expect(runtime.cancel).toHaveBeenCalledWith({ sessionId: session.sessionId });
          expect(runtime.closeSession).toHaveBeenCalledWith({ sessionId: session.sessionId });
        } else {
          await vi.waitFor(() =>
            expect(respond).toHaveBeenCalledWith(
              "start",
              expect.objectContaining(
                pendingStage === "clientDisconnect" || pendingStage === "serviceDispose"
                  ? {
                      status: "interrupted",
                      diagnosticCode: "host_disconnected",
                    }
                  : { status: "cancelled", diagnosticCode: "cancelled_before_prompt" },
              ),
            ),
          );
        }
        if (serviceDisposePromise) await serviceDisposePromise;
        if (pendingStage !== "acceptedAck") expect(runtime.prompt).not.toHaveBeenCalled();
        expect(runtime.closeSession).toHaveBeenCalledWith({ sessionId: session.sessionId });
      } finally {
        pendingPrompt.resolve({ stopReason: "cancelled" });
        disposed = true;
        await service.disposeAllAndWait();
      }
    },
  );
});
