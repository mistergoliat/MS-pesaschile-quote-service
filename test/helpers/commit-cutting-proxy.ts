import net from "node:net";

/*
 * TCP proxy in front of the test PostgreSQL that can make ONE transaction's
 * COMMIT outcome ambiguous at the wire level (R1.5B4 §22). It watches the
 * client→server stream of each connection: once a connection has sent the
 * trigger SQL (by default the T5 manifest insert), its next simple-protocol
 * `commit` message is cut:
 *
 * - "drop_commit": the COMMIT is never forwarded and both sockets are
 *   destroyed; PostgreSQL sees the connection die inside the transaction and
 *   rolls it back (outcome A: commit did not land).
 * - "drop_commit_response": the COMMIT is forwarded, the server's reply is
 *   swallowed and both sockets are destroyed once it arrives (outcome B:
 *   commit landed, the client never learns it).
 *
 * In both cases the driver reports a terminated connection during COMMIT,
 * which the application turns into CommitOutcomeUnknownError: a real,
 * not simulated, ambiguous commit. One cut per arm().
 */

export type CommitCutMode = "drop_commit" | "drop_commit_response";

const COMMIT_MESSAGE = Buffer.from("commit\u0000", "latin1");

export class CommitCuttingProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private armed: { mode: CommitCutMode; trigger: string } | null = null;
  readonly cuts: Array<{ readonly mode: CommitCutMode; readonly at: number }> = [];
  #port = 0;

  private constructor(
    private readonly targetHost: string,
    private readonly targetPort: number
  ) {}

  static async create(targetHost: string, targetPort: number): Promise<CommitCuttingProxy> {
    const proxy = new CommitCuttingProxy(targetHost, targetPort);
    await proxy.listen();
    return proxy;
  }

  route(connectionString: string): string {
    const url = new URL(connectionString);
    url.hostname = "127.0.0.1";
    url.port = String(this.#port);
    return url.toString();
  }

  arm(mode: CommitCutMode, trigger = "insert into quote_service.quote_documents"): void {
    this.armed = { mode, trigger };
  }

  get isArmed(): boolean {
    return this.armed !== null;
  }

  async dispose(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private listen(): Promise<void> {
    const server = net.createServer((client) => this.handle(client));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.#port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private handle(client: net.Socket): void {
    const upstream = net.connect(this.targetPort, this.targetHost);
    this.track(client);
    this.track(upstream);
    let sawTrigger = false;
    let tail = "";
    let swallowReply = false;

    const destroyBoth = () => {
      client.destroy();
      upstream.destroy();
    };

    client.on("data", (chunk: Buffer) => {
      const armed = this.armed;

      if (armed && !sawTrigger) {
        const text = tail + chunk.toString("latin1");
        sawTrigger = text.includes(armed.trigger);
        tail = text.slice(-armed.trigger.length);
      }

      if (armed && sawTrigger && chunk.includes(COMMIT_MESSAGE)) {
        this.armed = null;
        this.cuts.push({ mode: armed.mode, at: Date.now() });

        if (armed.mode === "drop_commit") {
          destroyBoth();
          return;
        }

        swallowReply = true;
      }

      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (swallowReply) {
        // The server answered the COMMIT: it is durable. The client never sees it.
        destroyBoth();
        return;
      }

      client.write(chunk);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }
}
