# Remote session survival (disconnect, replay, crash)

Status: accepted invariants for `web-remote-replayable` and `desktop-continuous` transports.
Scope: `packages/zcode-server-cli`, `packages/services` connection scope, `apps/zcode-cli`
v4 gateway/publisher, `packages/ui` conversation projection store. No production behavior
changes are required by this document; it pins down existing ownership and adds regression
coverage for the disconnect/reconnect path.

## 1. Problem statement

A remote client (desktop Host or phone Web) can lose its WebSocket/SSH tunnel while an agent
turn keeps running in the CLI. Closing the transport must not cancel the turn, and the next
attachment must observe the same session/run and replay the gap exactly once. Conversely, a
CLI process restart must invalidate the old log epoch so the client cannot "continue" a stale
run, and a hard crash must fail closed instead of re-executing in-flight tools.

## 2. State owners (single writer per fact)

| Fact                                                           | Owner                                                                              | Evidence                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn/Task execution and its continuation after disconnect      | CLI runtime / session resident pool; disconnect only disposes the connection scope | `packages/zcode-server-cli/src/server-core/http.ts:189-194`, `packages/services/src/zcode-agent/connection-scope/createScope.ts:608-626`                                                                                                                                                                                           |
| Command admission (busy/running input queue)                   | CLI/runtime `CommandInbox`; cleared only on session deactivate/dispose             | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway-lifecycle.ts:35,57`                                                                                                                                                                                                                                            |
| Session attachment / deactivation guard                        | session resident pool (active work and subscribers block deactivate)               | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts:231-241`                                                                                                                                                                                                                                            |
| Conversation event log, retention window, log epoch            | `ConversationTopicPublisher` (projection + per-subscriber buffers)                 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`                                                                                                                                                                                                                                          |
| Replay decision (`resume` vs `snapshot`)                       | publisher `subscribe(base)` using `logEpoch + seq`                                 | `packages/shared/src/zcode-protocol-v4/protocol-v4-transport-part1.ts:73-83`                                                                                                                                                                                                                                                       |
| Client projection seq/epoch, duplicate/gap handling            | UI `ConversationProjectionFrames`                                                  | `packages/ui/src/v4/conversation-projection-store/frames.ts:147-156`, `connection.ts:160,194,207,428-439`                                                                                                                                                                                                                          |
| Crash recovery markers (`interruptedToolCount`, `lastOutcome`) | core resume/hydrator + bootstrap auto-resume guard                                 | `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:302,362`, `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts:49,231-236`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/auto-resume.ts:9-17,41-52`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations-part4.ts:107-117` |

No Host-side owner/lease/mirror bridge exists or is introduced: Main/relay only forward, the
CLI owns turn state, and the UI owns only its projection.

## 3. Invariants

1. **Disconnect does not cancel.** Closing a client WebSocket disposes the connection scope
   (unsubscribes its projection subscriptions) but never aborts an active turn, clears the
   command queue, or deactivates the CLI session. The turn runs to its terminal event while
   the client is absent.
2. **Reconnect attaches to the same identity.** Reattachment is matched by
   `workspaceIdentity` (fallback `workspacePath`) plus `remoteSessionId`/session id, never by
   socket identity. A new socket gets a new `connectionId` and a fresh connection scope.
3. **Replay is epoch- and seq-based.** `resume` is granted only when `base.logEpoch` equals
   the publisher epoch and `base.seq` is inside the retention window; otherwise the server
   sends a full `snapshot`. A snapshot frame supersedes the client copy; deltas require
   `fromSeq === store.seq`.
4. **Delivery is at-least-once; application is exactly-once.** Re-delivered frames with
   `toSeq <= store.seq` are ignored. Re-subscribing at the current watermark returns no
   initial frame, so repeated reconnects do not duplicate rows or re-run the turn.
5. **Repeated attach is idempotent.** Multiple sequential or concurrent attachments never
   start a second agent run for the same accepted input; the previous subscription id becomes
   invalid on resubscribe.
6. **Stale epoch never continues.** After a CLI restart the new publisher has a new
   `logEpoch`; any base from the old process is answered with `snapshot` of the new run (or
   an empty projection), never with old-run continuation. In-flight Tasks are not auto-restarted.
7. **Cancellation, timeouts, permissions fail closed.** `stop` is a normal command and is
   delivered once per command id; abort/timeout/permission errors terminate the turn as
   `cancelled`/`error`, not as success. Missing or mismatched execution tokens are no-ops
   (`guard.stopTargetChanged`), not blind aborts.
8. **Crash recovery fails closed.** Hard crash marks non-completed tool parts as interrupted
   (`interruptedToolCount`). Auto-resume runs only for `lastOutcome === "interrupted"` root
   interactive sessions without pending tools and once per source user message. Pending tools
   block auto-resume; in-flight Task/tool calls are never re-executed (duplicate side effects).
9. **Two transport semantics stay distinct.** `desktop-continuous` is a trusted Host relay
   with live event streaming; `web-remote-replayable` is a resumable, snapshot/seq-based
   stream. Both must satisfy the same survival invariants, but replay and queueing are tested
   separately; neither is emulated by the other.

## 4. Event order on reconnect

```
client socket #1                Core / connection scope               CLI runtime
  subscribe(base=None)  ->      scope.subscribe  ->  publisher.subscribe
  <snapshot>                    |                     |
  sendText(cmd-1)       ->      scope forwards   ->  CommandInbox -> run starts
  X close socket                scope.dispose (unsubscribe only)      run continues
                                ... terminal events appended to log ...
client socket #2
  subscribe(base={epoch,seq}) -> publisher.subscribe -> resume|snapshot
  <gap frames + live frames>    (same run, no new run)
```

## 5. Acceptance scenarios

- AC1 (Core WS): connect desktop WS, subscribe, submit a turn, close the socket mid-turn;
  the runtime completes exactly one run and never sees a cancel; reconnecting with
  `base={logEpoch, seq}` yields the missed frames/final state; a second reconnect is
  idempotent and still one run.
- AC2 (Core WS): closing a socket without active work releases the connection's
  subscriptions; the server stays healthy.
- AC3 (publisher): `base` inside the same epoch/retention resumes from `seq`; at the current
  watermark it returns no frame; outside retention it returns a snapshot.
- AC4 (publisher): a stale epoch base after restart returns a snapshot equal to the new
  epoch's projection, with no rows from the old run.
- AC5 (gateway): duplicate `stop` command ids execute the cancellation once
  (`session-survival-reconnect.test.ts:216`); a mismatched foreground token / run id is a
  no-op (`v4-native-commands.test.ts:1988,2005,2106,2167`, `guard.stopTargetChanged`).
- AC6 (auto-resume): interrupted session with a pending tool is not auto-resumed and no
  `submitPrompt` occurs; a completed-only interruption may resume once per user message.
- AC7 (UI store): a mid-stream gap triggers `resync(base)`, duplicate re-delivery is ignored,
  and the final projection equals a full replay from seq 0.

Regression suites:
`packages/zcode-server-cli/test/coreHttpReconnect.test.ts`,
`apps/zcode-cli/packages/bootstrap/tests/session-survival-reconnect.test.ts`,
`apps/zcode-cli/packages/bootstrap/tests/auto-resume.test.ts`,
`apps/zcode-cli/packages/bootstrap/tests/v4-native-commands.test.ts` (AC5 token mismatch),
`packages/ui/test/v4SessionDataLayer.test.ts` (AC7, `:754-805`).
