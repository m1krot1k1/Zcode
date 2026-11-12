# Client WebSocket Lifecycle

## Problem

`packages/client/src/websocket.ts` treated the browser WebSocket as a fire-and-forget
channel:

- `write()` silently dropped frames when `readyState !== OPEN`, so an RPC sent on a
  closing socket waited forever.
- Closing or erroring the socket never reached `ChannelClient`, so pending RPC
  promises stayed pending and kept upper-layer dedupe keys occupied.
- The handshake made exactly one attempt; transient failures surfaced immediately.

## Contract

`connectViaWebSocket(wsUrl, options?)` owns the **handshake** lifecycle:

1. **Bounded handshake retry.** Pre-open `error`/`close` failures retry with
   exponential backoff: default 3 attempts, 500ms initial delay, 5s cap. Attempts
   can be tuned with `reconnect: { attempts, initialDelayMs, maxDelayMs }` or
   disabled with `reconnect: false`. When the budget is exhausted the promise
   rejects with the last failure (`onReconnect` receives each retry).
2. **Fail-closed pending RPC.** Once the socket is open, the client creates one
   `ChannelClient` for the connection. Any subsequent `close` or `error` disposes
   that client with `WebSocketConnectionClosedError`
   (`name: "ConnectionClosed"`, carrying `code` and `reason`), which rejects every
   pending RPC instead of leaving it hanging.
3. **Explicit write failure.** Writing to a non-OPEN socket throws
   `WebSocketNotOpenError` naming the URL and current `readyState`; it is no longer
   a silent no-op.
4. **No transparent mid-session reconnect.** `ChannelClient` is bound to a fixed
   `SocketProtocol`; replaying in-flight RPC and event subscriptions would require
   protocol-level resume that the client does not have. After a connection is
   established, `onClose(event)` is the ownership handoff: the caller (web
   bootstrap, desktop host) decides whether to rebuild the connection. `onClose`
   only fires for established connections; pre-open failures are reported through
   the promise/reconnect callback so retries do not fake connection churn.

## Verification

`packages/client/test/websocket.test.ts` covers:

- pending RPC rejects on `close` and on `error`;
- `write` throws before open and after close, and still sends while open;
- handshake retry succeeds after transient failures;
- retry budget exhaustion and `reconnect: false` reject after one attempt;
- `onClose` fires once, only for an established connection.
