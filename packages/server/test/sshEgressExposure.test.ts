import { describe, expect, it, vi } from "vitest";
import { SshEgressExposure } from "../src/remote/sshEgressExposure.js";

/**
 * The SSH client is created once and reused across reconnects, so a
 * `tcp connection` listener left behind outlives its forward. It keeps its old
 * port, sees the next generation's channel as a mismatch and rejects it before
 * the current listener can accept — which kills the tunnel for good after the
 * first reconnect, while the log still reports a fresh port.
 */

interface FakeClient {
  on(event: string, listener: never): void;
  off(event: string, listener: never): void;
  forwardIn(address: string, port: number, cb: (error?: Error, assigned?: number) => void): void;
  unforwardIn(address: string, port: number, cb: () => void): void;
  emit(details: { destPort: number }, accept: () => never, reject: () => void): void;
  listenerCount(): number;
}

function fakeClient(ports: number[]): FakeClient {
  const listeners: Array<(d: { destPort: number }, a: () => never, r: () => void) => void> = [];
  let next = 0;
  return {
    on(event, listener) {
      if (event === "tcp connection") listeners.push(listener);
    },
    off(event, listener) {
      if (event !== "tcp connection") return;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    forwardIn(_address, _port, cb) {
      cb(undefined, ports[next++]);
    },
    unforwardIn() {},
    emit(details, accept, reject) {
      // ssh2 dispatches to every listener, exactly as modelled here.
      for (const listener of [...listeners]) listener(details, accept, reject);
    },
    listenerCount: () => listeners.length,
  };
}

function fakeSocket(): never {
  return {
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    pipe: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

describe("SshEgressExposure", () => {
  it("keeps working after a reconnect instead of rejecting the new channel", async () => {
    const client = fakeClient([41001, 41002]);
    const exposure = new SshEgressExposure(client as never);

    await exposure.install();
    expect(exposure.proxyUrl).toBe("http://127.0.0.1:41001");

    // A reconnect: the old forward is gone and a new port is assigned.
    exposure.reset();
    await exposure.install();
    expect(exposure.proxyUrl).toBe("http://127.0.0.1:41002");

    const accept = vi.fn(() => fakeSocket());
    const reject = vi.fn();
    client.emit({ destPort: 41002 }, accept, reject);

    // The stale generation's listener must be gone, so only the live one answers.
    expect(reject).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("does not accumulate listeners across repeated installs", async () => {
    const client = fakeClient([42001, 42002, 42003]);
    const exposure = new SshEgressExposure(client as never);

    await exposure.install();
    exposure.reset();
    await exposure.install();
    exposure.reset();
    await exposure.install();

    expect(client.listenerCount()).toBe(1);
  });

  it("still rejects a channel aimed at another port", async () => {
    const client = fakeClient([43001]);
    const exposure = new SshEgressExposure(client as never);
    await exposure.install();

    const accept = vi.fn(() => fakeSocket());
    const reject = vi.fn();
    client.emit({ destPort: 11434 }, accept, reject);

    expect(reject).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  /**
   * A fresh connection reaches install() twice at once: `handleReady` fires it
   * fire-and-forget and `transportAdapter.deliverAgentNetworkHandoff` awaits
   * `resolveRuntimeProxy()`. The `forwardPort` guard sits before two awaits, so
   * both callers passed it and each requested its own reverse forward — two
   * remote ports, one leaked, and the published URL depended on which
   * `forwardIn` callback returned last.
   *
   * The fixture below resolves `forwardIn` on a later tick on purpose: the
   * synchronous fake in this file is what hid the window from the suite.
   *
   * The duplicate forward is only half of it: the relay guard is in the same
   * position, so each concurrent caller also bound its own loopback proxy
   * server. Measured on the shipped code with `getActiveResourcesInfo`, one
   * fresh connect added two listening servers and leaked one; with the fix it
   * adds one. Counting `forwardIn` calls is the assertion that follows from
   * both.
   */
  function asyncFakeClient(ports: number[]): FakeClient & { forwardCount(): number } {
    const listeners: Array<(d: { destPort: number }, a: () => never, r: () => void) => void> = [];
    let forwards = 0;
    let next = 0;
    return {
      on(event, listener) {
        if (event === "tcp connection") listeners.push(listener);
      },
      off(event, listener) {
        if (event !== "tcp connection") return;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      forwardIn(_address, _port, cb) {
        forwards += 1;
        const assigned = ports[next++];
        setTimeout(() => cb(undefined, assigned), 5);
      },
      unforwardIn() {},
      emit(details, accept, reject) {
        for (const listener of Array.from(listeners)) listener(details, accept, reject);
      },
      listenerCount: () => listeners.length,
      forwardCount: () => forwards,
    };
  }

  it("requests one forward when two callers install at once", async () => {
    const client = asyncFakeClient([44001, 44002]);
    const exposure = new SshEgressExposure(client as never);

    // Exactly the production order: fire-and-forget first, awaited second.
    const fireAndForget = exposure.install();
    const awaited = exposure.install();
    await Promise.allSettled([fireAndForget, awaited]);

    expect(client.forwardCount()).toBe(1);
    expect(client.listenerCount()).toBe(1);
    expect(exposure.proxyUrl).toBe("http://127.0.0.1:44001");
  });

  it("does not publish a forward that a reconnect overtook", async () => {
    const client = asyncFakeClient([45001, 45002]);
    const exposure = new SshEgressExposure(client as never);

    const installing = exposure.install();
    // The connection drops while the forward request is still in flight.
    exposure.reset();
    await installing;

    expect(exposure.proxyUrl).toBeUndefined();
    const accept = vi.fn(() => fakeSocket());
    const reject = vi.fn();
    client.emit({ destPort: 45001 }, accept, reject);
    expect(accept).not.toHaveBeenCalled();
  });

  /**
   * The other half of that window, and the one dedupe can break: if the
   * in-flight install is deduped by a promise that is not scoped to the
   * generation, the reconnected connection is handed the dead generation's
   * install, which correctly refuses to publish — and the live connection ends
   * up with no tunnel at all, worse than the duplicate this replaces.
   */
  it("gives the reconnected generation its own tunnel", async () => {
    const client = asyncFakeClient([46001, 46002]);
    const exposure = new SshEgressExposure(client as never);

    const overtaken = exposure.install();
    exposure.reset();
    const reconnected = exposure.install();
    await Promise.allSettled([overtaken, reconnected]);

    // One forward per generation, and the live one is published.
    expect(client.forwardCount()).toBe(2);
    expect(client.listenerCount()).toBe(1);
    expect(exposure.proxyUrl).toBe("http://127.0.0.1:46002");
  });
});
