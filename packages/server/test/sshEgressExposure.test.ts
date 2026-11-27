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
});
