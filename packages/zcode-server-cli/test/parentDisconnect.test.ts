import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installParentDisconnectHandler,
  installStdinCloseHandler,
} from "../src/server-core/parentDisconnect.js";

describe("Server Core parent disconnect", () => {
  it("runs cleanup when the Supervisor IPC channel disconnects", () => {
    const cleanup = vi.fn();
    const source = new EventEmitter();
    const dispose = installParentDisconnectHandler(cleanup, source);

    source.emit("disconnect");

    expect(cleanup).toHaveBeenCalledOnce();
    dispose();
  });

  it("can remove the handler before a disconnect", () => {
    const cleanup = vi.fn();
    const source = new EventEmitter();
    const dispose = installParentDisconnectHandler(cleanup, source);
    dispose();

    source.emit("disconnect");

    expect(cleanup).not.toHaveBeenCalled();
  });
});

class FakeStdin extends EventEmitter {
  resumed = 0;
  constructor(readonly isTTY: boolean = false) {
    super();
  }
  resume(): void {
    this.resumed += 1;
  }
}

describe("Server Core stdin lifecycle", () => {
  it("resumes a paused pipe stdin so the EOF is actually delivered", () => {
    // A paused stream never emits `end`; without resume the handler was unreachable
    // in a real process, which the process-level probe caught.
    const stdin = new FakeStdin();
    const dispose = installStdinCloseHandler(vi.fn(), { hasParentChannel: false, source: stdin });

    expect(stdin.resumed).toBe(1);
    dispose();
  });
  it("shuts down when the remote client closes the channel (stdin end)", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin();
    const dispose = installStdinCloseHandler(cleanup, {
      hasParentChannel: false,
      source: stdin,
    });

    stdin.emit("end");

    expect(cleanup).toHaveBeenCalledOnce();
    dispose();
  });

  it("shuts down when stdin is closed rather than ended", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin();
    const dispose = installStdinCloseHandler(cleanup, {
      hasParentChannel: false,
      source: stdin,
    });

    stdin.emit("close");

    expect(cleanup).toHaveBeenCalledOnce();
    dispose();
  });

  it("never fires twice for the same closed channel", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin();
    const dispose = installStdinCloseHandler(cleanup, {
      hasParentChannel: false,
      source: stdin,
    });

    stdin.emit("end");
    stdin.emit("close");

    expect(cleanup).toHaveBeenCalledOnce();
    dispose();
  });

  it("stays inert under the Supervisor, which stops the Core over IPC", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin();
    installStdinCloseHandler(cleanup, { hasParentChannel: true, source: stdin });

    stdin.emit("end");

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("stays inert on a terminal, where EOF does not signal a client exit", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin(true);
    installStdinCloseHandler(cleanup, { hasParentChannel: false, source: stdin });

    stdin.emit("end");

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("can remove the handler before the channel closes", () => {
    const cleanup = vi.fn();
    const stdin = new FakeStdin();
    const dispose = installStdinCloseHandler(cleanup, {
      hasParentChannel: false,
      source: stdin,
    });
    dispose();

    stdin.emit("end");

    expect(cleanup).not.toHaveBeenCalled();
  });
});
