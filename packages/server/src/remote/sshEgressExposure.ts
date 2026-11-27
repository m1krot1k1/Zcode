import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import type { Client as SSHClient } from "ssh2";
import { createEgressRelay, type EgressRelay } from "./egressRelay.js";

/**
 * Device-side egress exposure for an isolated SSH workspace.
 *
 * A remote host can be reachable over SSH while having no outbound internet of
 * its own. Model requests issued on that host then fail before any provider is
 * reached, and nothing on the remote can repair it. This keeps a loopback relay
 * on the device and reverse-forwards a remote loopback port to it, so the
 * remote agent can borrow this machine's egress.
 *
 * Kept out of `SSHBackend` because the forwarding lifecycle — a new remote port
 * per connection, one listener per port, teardown with the connection — is a
 * concern of its own and the backend file is at its size limit.
 */
type TcpConnectionListener = (
  details: { destPort: number },
  accept: () => Duplex,
  reject: () => void,
) => void;

export class SshEgressExposure {
  private relay: EgressRelay | undefined;
  private forwardPort: number | undefined;
  private url: string | undefined;
  /**
   * The `tcp connection` listener for the current forward. The SSH client is
   * created once and reused across reconnects, so a listener left behind
   * survives into the next generation: it keeps its old port, sees the new
   * generation's channel as a mismatch and rejects it before the current
   * listener can accept — the tunnel then dies after the first reconnect.
   */
  private channelListener: TcpConnectionListener | undefined;

  constructor(private readonly client: SSHClient) {}

  /** The proxy URL the remote should use, undefined until a forward exists. */
  get proxyUrl(): string | undefined {
    return this.url;
  }

  /**
   * Install the reverse forward if it is not already there.
   *
   * `forwardIn` is re-requested after every reconnect because the tunnel dies
   * with the SSH connection, and the remote port is re-chosen each time so a
   * listener from a previous generation can never be reused by mistake.
   */
  async install(): Promise<void> {
    if (!this.relay) {
      this.relay = await createEgressRelay();
    }
    if (this.forwardPort !== undefined) return;

    const relayPort = this.relay.port;
    const forwardIn = (
      this.client as unknown as {
        forwardIn(
          address: string,
          port: number,
          callback: (error?: Error, assignedPort?: number) => void,
        ): void;
      }
    ).forwardIn.bind(this.client);

    const assignedPort = await new Promise<number>((resolve, reject) => {
      forwardIn("127.0.0.1", 0, (error, port) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof port !== "number" || port <= 0) {
          reject(new Error("ssh server did not assign a remote egress port"));
          return;
        }
        resolve(port);
      });
    });

    // One listener per connection: the remote half of a later forward must not
    // reach a relay that a previous generation replaced.
    const listener: TcpConnectionListener = (details, accept, reject) => {
      if (details.destPort !== assignedPort) {
        reject();
        return;
      }
      const channel = accept();
      const socket = netConnect({ host: "127.0.0.1", port: relayPort });
      socket.on("error", () => channel.destroy());
      channel.on("error", () => socket.destroy());
      channel.pipe(socket);
      socket.pipe(channel);
    };
    this.detachListener();
    (
      this.client as unknown as {
        on(event: "tcp connection", listener: TcpConnectionListener): void;
      }
    ).on("tcp connection", listener);
    this.channelListener = listener;

    this.forwardPort = assignedPort;
    this.url = `http://127.0.0.1:${assignedPort}`;
    console.log(`[ssh] egress relay exposed to remote on port ${assignedPort}`);
  }

  /** Forget the current tunnel. A reconnect gets a fresh port, so a stale URL
   * must never be handed to a later spawn — and the old listener must go with it.
   */
  reset(): void {
    this.detachListener();
    this.forwardPort = undefined;
    this.url = undefined;
  }

  private detachListener(): void {
    const listener = this.channelListener;
    if (!listener) return;
    (
      this.client as unknown as {
        off(event: "tcp connection", listener: TcpConnectionListener): void;
      }
    ).off("tcp connection", listener);
    this.channelListener = undefined;
  }

  /** Drop the forward before the connection goes away; the relay itself is loopback-only. */
  dispose(): void {
    if (this.forwardPort !== undefined) {
      try {
        this.client.unforwardIn("127.0.0.1", this.forwardPort, () => {});
      } catch {
        // The tunnel dies with the connection anyway; teardown stays total.
      }
      this.reset();
    }
  }
}
