/**
 * Runs INSIDE the sandbox (no network): listens on 127.0.0.1:<port> and forwards
 * to the proxy unix socket, then execs the agent command with HTTPS_PROXY set.
 * Usage: node bridge.js <socket> <port> -- <command> [args...]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [socketPath, portText] = argv;
const command = argv.slice(sep + 1);
if (!socketPath || !portText || sep < 0 || command.length === 0) {
  process.stderr.write('uso: bridge.js <socket> <puerto> -- <comando>\n');
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

server.listen(Number(portText), '127.0.0.1', () => {
  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);
  child.on('exit', (code, signal) => {
    server.close();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    process.stderr.write(`bridge: no se pudo ejecutar ${command[0]}: ${error.message}\n`);
    process.exit(127);
  });
});
