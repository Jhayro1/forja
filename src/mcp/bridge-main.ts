#!/usr/bin/env node
/**
 * Runs INSIDE the agent's sandbox as its only MCP server: pipes stdio to the
 * gateway socket mounted for this launch. It holds no logic and no secrets.
 *
 * If the gateway goes away (`forja run` restarted while this agent kept
 * working), it answers the requests in flight with an error and reconnects to
 * the same path, where the new process recreates the socket (MEJORAS 4.7).
 * Usage: node bridge-main.js <socket>
 */
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('uso: bridge-main.js <socket>\n');
  process.exit(2);
}

const GIVE_UP_MS = 120_000;
const pending = new Set<string>();
const queue: string[] = [];
let socket: net.Socket | null = null;
let connected = false;
let down: number | null = null;
let stdinEnded = false;
let fromGateway = '';
let fromAgent = '';

const idOf = (line: string): string | null => {
  try {
    const m = JSON.parse(line) as { id?: unknown; method?: unknown };
    return m.id !== undefined && m.id !== null ? JSON.stringify(m.id) : null;
  } catch {
    return null;
  }
};

const fail = (id: string, message: string) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(id), error: { code: -32000, message } })}\n`);

function connect(): void {
  const s = net.connect(socketPath!);
  socket = s;
  s.on('connect', () => {
    connected = true;
    down = null;
    for (const line of queue.splice(0)) {
      const id = idOf(line);
      if (id) pending.add(id);
      s.write(`${line}\n`);
    }
  });
  s.on('data', (chunk) => {
    fromGateway += chunk.toString('utf8');
    let i = fromGateway.indexOf('\n');
    while (i >= 0) {
      const line = fromGateway.slice(0, i);
      fromGateway = fromGateway.slice(i + 1);
      const id = idOf(line);
      if (id) pending.delete(id);
      process.stdout.write(`${line}\n`);
      i = fromGateway.indexOf('\n');
    }
  });
  const lost = () => {
    if (socket !== s) return;
    socket = null;
    connected = false;
    fromGateway = '';
    down ??= Date.now();
    // Requests that were in flight will never be answered by the old gateway.
    for (const id of pending) fail(id, 'el gateway de Forja se reinició: vuelve a intentarlo');
    pending.clear();
    if (stdinEnded) process.exit(0);
    if (Date.now() - down > GIVE_UP_MS) {
      for (const line of queue.splice(0)) {
        const id = idOf(line);
        if (id) fail(id, 'el gateway de Forja no está disponible');
      }
      process.stderr.write('forja-mcp: sin gateway\n');
      process.exit(1);
    }
    setTimeout(connect, 1000);
  };
  s.on('error', lost);
  s.on('close', lost);
}

process.stdin.on('data', (chunk) => {
  fromAgent += chunk.toString('utf8');
  let i = fromAgent.indexOf('\n');
  while (i >= 0) {
    const line = fromAgent.slice(0, i);
    fromAgent = fromAgent.slice(i + 1);
    if (line.trim()) {
      if (connected && socket) {
        const id = idOf(line);
        if (id) pending.add(id);
        socket.write(`${line}\n`);
      } else queue.push(line);
    }
    i = fromAgent.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  if (socket) socket.end();
  else process.exit(0);
});
connect();
