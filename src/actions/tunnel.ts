import { unlinkSync } from 'node:fs';
import net from 'node:net';

/**
 * The sandboxed executor's only way out (MEJORAS 4.2). It runs without network;
 * this CONNECT proxy on a unix socket, in the parent process, opens a TCP
 * connection ONLY to the destinations of the approved action, and to the address
 * the parent already resolved and checked (never re-resolving the name).
 */
export class PinnedTunnelProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  readonly decisions: { target: string; allowed: boolean }[] = [];

  /** `pins`: "host:port" → pinned IP. */
  constructor(
    private readonly socketPath: string,
    private readonly pins: ReadonlyMap<string, string>,
  ) {}

  start(): Promise<void> {
    this.server = net.createServer((client) => this.handle(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  private handle(client: net.Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 4096) client.destroy();
        return;
      }
      client.off('data', onData);
      const m = /^CONNECT (\[?[A-Za-z0-9.:-]+\]?):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head);
      const target = m ? `${m[1]!.replace(/^\[|\]$/g, '').toLowerCase()}:${m[2]}` : '';
      const ip = this.pins.get(target);
      this.decisions.push({ target, allowed: ip !== undefined });
      if (!ip) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = net.connect(Number(m![2]), ip, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      // Refused before connecting: the request never left (the executor reports «no enviado»).
      upstream.on('error', (e: NodeJS.ErrnoException) => (client.writable ? client.end(`HTTP/1.1 502 ${e.code ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`) : client.destroy()));
    };
    client.on('data', onData);
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

/** Executor side: a TCP stream to host:port through the parent's tunnel. */
export function openTunnel(socketPath: string, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    let head = '';
    s.once('error', (e) => reject(Object.assign(e, { notSent: true })));
    s.once('connect', () => s.write(`CONNECT ${host.includes(':') ? `[${host}]` : host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.off('data', onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
      if (status === '200') resolve(s);
      else {
        s.destroy();
        reject(Object.assign(new Error(`el túnel respondió ${head.split('\r\n')[0]}`), { notSent: true, code: status === '403' ? 'EBLOQUEADO' : 'ECONNREFUSED' }));
      }
    };
    s.on('data', onData);
  });
}
