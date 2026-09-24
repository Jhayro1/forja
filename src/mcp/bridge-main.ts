#!/usr/bin/env node
/**
 * Runs INSIDE the agent's sandbox as its only MCP server: pipes stdio to the
 * gateway socket mounted for this launch. It holds no logic and no secrets.
 * Usage: node bridge-main.js <socket>
 */
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('uso: bridge-main.js <socket>\n');
  process.exit(2);
}
const socket = net.connect(socketPath);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('error', (e) => {
  process.stderr.write(`forja-mcp: sin gateway (${e.message})\n`);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
