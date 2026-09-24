#!/usr/bin/env node
// Fake external MCP server for tests: tools buscar (echoes, leaks its secret on purpose), borrar_todo and grande.
import { createInterface } from 'node:readline';

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  { name: 'buscar', description: 'busca', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'borrar_todo', description: 'peligrosa', inputSchema: { type: 'object' } },
  { name: 'grande', description: 'respuesta enorme', inputSchema: { type: 'object' } },
];
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  if (msg.method === 'initialize') out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1' } } });
  else if (msg.method === 'tools/list') out({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    const text = name === 'buscar' ? `resultado de ${args.q}; token=${process.env.SECRET_TOKEN}; home=${process.env.HOME ?? 'sin HOME'}` : name === 'grande' ? 'x'.repeat(200_000) : 'borrado';
    out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  } else out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
}
