import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import type { OpenCodeAgentRunRecord, SessionStorePort } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

function runRecord(overrides: Partial<OpenCodeAgentRunRecord> = {}): OpenCodeAgentRunRecord {
  return {
    schemaVersion: 1,
    sessionID: "session-1" as OpenCodeAgentRunRecord["sessionID"],
    runID: "command-1",
    commandID: "command-1",
    inputID: "command-1",
    routeKind: "opencode-cli",
    status: "dispatching",
    eventSequence: 1,
    hostEventSequence: 0,
    time: { created: 1, updated: 1 },
    promptText: "Проверь проект",
    outputText: "",
    toolActivity: [],
    ...overrides,
  };
}

function eventMessage(event: unknown): ZCodeProtocolMessage {
  return {
    method: zcodeProtocolMethods.interactionOpenCodeAgentRunEvent,
    params: event,
  } as ZCodeProtocolMessage;
}

describe("OpenCode delegated run Host events", () => {
  it("preserves the SessionStore receiver while reading the run before and after persistence", async () => {
    const store = {
      current: runRecord(),
      async getOpenCodeAgentRun(this: { current: OpenCodeAgentRunRecord }) {
        return this.current;
      },
      async applyOpenCodeAgentRunHostEvent(
        this: { current: OpenCodeAgentRunRecord },
        transition: {
          status: OpenCodeAgentRunRecord["status"];
          eventSequence: number;
          hostEventSequence: number;
          openCodeSessionID?: string;
        },
      ) {
        this.current = runRecord({
          ...this.current,
          status: transition.status,
          eventSequence: transition.eventSequence,
          hostEventSequence: transition.hostEventSequence,
          openCodeSessionID: transition.openCodeSessionID,
        });
        return true;
      },
    } as unknown as SessionStorePort & { current: OpenCodeAgentRunRecord };
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: "/workspace",
      sessionStore: store,
      version: "test-version",
    });

    try {
      await expect(
        server.handleMessage(
          eventMessage({
            protocolVersion: 1,
            zcodeSessionId: "session-1",
            commandId: "command-1",
            runId: "command-1",
            opencodeSessionId: "acp-session-1",
            sequence: 1,
            event: { type: "started" },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(store.current).toMatchObject({
        status: "running",
        openCodeSessionID: "acp-session-1",
        hostEventSequence: 1,
      });
    } finally {
      await server.shutdown();
    }
  });

  it("applies only exact-next events for the matching run and ACP session", async () => {
    let current = runRecord();
    const apply = vi.fn(async (transition) => {
      current = runRecord({
        status: transition.status,
        eventSequence: transition.eventSequence,
        hostEventSequence: transition.hostEventSequence,
        openCodeSessionID: transition.openCodeSessionID,
      });
      return true;
    });
    const store = {
      getOpenCodeAgentRun: vi.fn(async () => current),
      applyOpenCodeAgentRunHostEvent: apply,
    } as unknown as SessionStorePort;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: "/workspace",
      sessionStore: store,
      version: "test-version",
    });

    try {
      await server.handleMessage(
        eventMessage({
          protocolVersion: 1,
          zcodeSessionId: "session-1",
          commandId: "command-1",
          runId: "command-1",
          opencodeSessionId: "acp-session-1",
          sequence: 1,
          event: { type: "started" },
        }),
      );
      expect(apply).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedStatus: "dispatching",
          expectedEventSequence: 1,
          eventSequence: 2,
          expectedHostEventSequence: 0,
          hostEventSequence: 1,
          hostEvent: { type: "started" },
          openCodeSessionID: "acp-session-1",
          status: "running",
        }),
      );

      await server.handleMessage(
        eventMessage({
          protocolVersion: 1,
          zcodeSessionId: "session-1",
          commandId: "command-1",
          runId: "command-1",
          opencodeSessionId: "acp-session-other",
          sequence: 2,
          event: { type: "content", text: "hello" },
        }),
      );
      await server.handleMessage(
        eventMessage({
          protocolVersion: 1,
          zcodeSessionId: "session-1",
          commandId: "command-1",
          runId: "command-1",
          opencodeSessionId: "acp-session-1",
          sequence: 3,
          event: { type: "content", text: "gap" },
        }),
      );
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      await server.shutdown();
    }
  });

  it("projects ACP permission details live without appending them to the event journal", async () => {
    let current = runRecord({
      status: "running",
      eventSequence: 2,
      hostEventSequence: 0,
      openCodeSessionID: "acp-session-1",
    });
    const appended: unknown[] = [];
    const ingest = vi.fn();
    const store = {
      getOpenCodeAgentRun: vi.fn(async () => current),
      applyOpenCodeAgentRunHostEvent: vi.fn(async (transition) => {
        current = runRecord({
          ...current,
          eventSequence: transition.eventSequence,
          hostEventSequence: transition.hostEventSequence,
          outputText: current.outputText,
        });
        return true;
      }),
    } as unknown as SessionStorePort;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => createFakeApp(options),
      cwd: "/workspace",
      sessionStore: store,
      version: "test-version",
    });
    const context = (
      server as unknown as {
        context: {
          sessions: Map<string, unknown>;
          v4Gateway: { ingest: typeof ingest };
        };
      }
    ).context;
    context.sessions.set("session-1", {
      eventStore: {
        append: vi.fn(async (event: unknown) => {
          appended.push(event);
          return event;
        }),
      },
      traceContext: { traceId: "trace-1" },
    });
    context.v4Gateway = { ingest };

    try {
      await server.handleMessage(
        eventMessage({
          protocolVersion: 1,
          zcodeSessionId: "session-1",
          commandId: "command-1",
          runId: "command-1",
          opencodeSessionId: "acp-session-1",
          sequence: 1,
          event: {
            type: "permissionRequested",
            requestId: "permission-1",
            title: "Run command",
            inputSummary: "pnpm lint",
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          },
        }),
      );

      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        type: SessionEventType.OpenCodeAgentRunUpdated,
        payload: { runId: "command-1", status: "running" },
      });
      expect(JSON.stringify(appended[0])).not.toContain("permission-1");
      expect(ingest).toHaveBeenCalledTimes(2);
      expect(ingest.mock.calls[1]?.[1]).toMatchObject({
        type: SessionEventType.OpenCodeAgentPermissionUpdated,
        payload: {
          commandId: "command-1",
          runId: "command-1",
          opencodeSessionId: "acp-session-1",
          requestId: "permission-1",
          state: "requested",
          request: { title: "Run command", options: [{ optionId: "allow-once" }] },
        },
      });
    } finally {
      await server.shutdown();
    }
  });
});
