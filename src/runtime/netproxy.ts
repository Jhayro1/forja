import { unlinkSync } from 'node:fs';
import net from 'node:net';

export type ProxyDecision = { host: string; port: number; allowed: boolean };

/**
 * Forja's network filter (D2-20). The sandbox has no network at all; this CONNECT
 * proxy on a unix socket is its only way out, and only to allowlisted hosts.
 * Plain HTTP (non-CONNECT) is refused: every allowed destination uses TLS.
 */
export class AllowlistProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly allow: (host: string, port: number) => boolean,
    private readonly onDecision: (d: ProxyDecision) => void = () => {},
  ) {}

  start(): Promise<void> {
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Did not exist.
    }
    this.server = net.createServer((client) => this.handle(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  private handle(client: net.Socket): void {
    this.track(client);
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off('data', onData);
      const m = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head);
      if (!m) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
        return;
      }
      const host = m[1]!.toLowerCase();
      const port = Number(m[2]);
      const allowed = this.allow(host, port);
      this.onDecision({ host, port, allowed });
      if (!allowed) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      let established = false;
      const upstream = net.connect(port, host, () => {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = Buffer.from(head.slice(end + 4), 'latin1');
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      this.track(upstream);
      upstream.on('error', () => {
        if (established) client.destroy();
        else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
    client.on('error', () => client.destroy());
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already gone.
    }
  }
}

/** Host allowlist with exact names and `*.suffix` wildcards; only port 443. */
export function hostMatcher(hosts: readonly string[]): (host: string, port: number) => boolean {
  const exact = new Set(hosts.filter((h) => !h.startsWith('*.')));
  const suffixes = hosts.filter((h) => h.startsWith('*.')).map((h) => h.slice(1));
  return (host, port) => port === 443 && (exact.has(host) || suffixes.some((s) => host.endsWith(s)));
}
