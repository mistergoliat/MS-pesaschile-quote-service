import net from "node:net";

/**
 * A TCP forwarder in front of the disposable test PostgreSQL. `disable()`
 * closes the listener and destroys every live connection (connection refused
 * + dropped sockets, like a database outage); `enable()` listens again on the
 * same port (recovery). Lets tests exercise real driver failure paths.
 */
export class ToggleableTcpProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  #port = 0;

  private constructor(
    private readonly targetHost: string,
    private readonly targetPort: number
  ) {}

  static async create(targetHost: string, targetPort: number): Promise<ToggleableTcpProxy> {
    const proxy = new ToggleableTcpProxy(targetHost, targetPort);
    await proxy.enable();
    return proxy;
  }

  get port(): number {
    return this.#port;
  }

  /** Rewrites a connection string so it goes through this proxy. */
  route(connectionString: string): string {
    const url = new URL(connectionString);
    url.hostname = "127.0.0.1";
    url.port = String(this.#port);
    return url.toString();
  }

  enable(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }

    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.track(client);
      this.track(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    this.server = server;

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, "127.0.0.1", () => {
        server.off("error", reject);
        this.#port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  disable(): Promise<void> {
    const server = this.server;

    if (!server) {
      return Promise.resolve();
    }

    this.server = null;

    for (const socket of this.sockets) {
      socket.destroy();
    }

    this.sockets.clear();

    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  async dispose(): Promise<void> {
    await this.disable();
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }
}
