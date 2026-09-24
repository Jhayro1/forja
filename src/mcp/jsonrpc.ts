import type { Readable, Writable } from 'node:stream';

/**
 * JSON-RPC 2.0 with newline-delimited framing (MCP stdio transport). Shared by
 * the gateway (server side, one per agent launch) and the client used to talk
 * to registered external MCP servers.
 */

export type JsonRpcId = string | number;
export type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId | null; result?: unknown; error?: { code: number; message: string } };

export const RPC = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 } as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Splits a stream into JSON messages; oversize lines are dropped with an error, never buffered forever. */
export function readMessages(input: Readable, onMessage: (msg: unknown) => void, onError: (e: RpcError) => void, maxLine = 1024 * 1024): void {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onError(new RpcError(RPC.parse, 'JSON inválido'));
      }
    }
    if (buffer.length > maxLine) {
      buffer = '';
      onError(new RpcError(RPC.invalid, 'mensaje demasiado grande'));
    }
  });
}

export function writeMessage(out: Writable, msg: JsonRpcRequest | JsonRpcResponse): void {
  out.write(`${JSON.stringify(msg)}\n`);
}

/** Serves requests with `handle`; notifications (no id) get no answer. */
export function serveRpc(input: Readable, output: Writable, handle: (method: string, params: unknown) => Promise<unknown>): void {
  readMessages(
    input,
    (raw) => {
      const msg = raw as Partial<JsonRpcRequest>;
      if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        writeMessage(output, { jsonrpc: '2.0', id: (msg as { id?: JsonRpcId })?.id ?? null, error: { code: RPC.invalid, message: 'petición inválida' } });
        return;
      }
      const id = msg.id;
      handle(msg.method, msg.params).then(
        (result) => {
          if (id !== undefined) writeMessage(output, { jsonrpc: '2.0', id, result });
        },
        (error: unknown) => {
          if (id === undefined) return;
          const e = error instanceof RpcError ? error : new RpcError(RPC.internal, (error as Error).message);
          writeMessage(output, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
        },
      );
    },
    (e) => writeMessage(output, { jsonrpc: '2.0', id: null, error: { code: e.code, message: e.message } }),
  );
}

/** Minimal client: request/response by id with a timeout per call. */
export class RpcClient {
  private next = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 30_000,
  ) {
    readMessages(
      input,
      (raw) => {
        const msg = raw as JsonRpcResponse;
        if (msg?.id === undefined || msg.id === null) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
        else p.resolve(msg.result);
      },
      () => undefined,
    );
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RPC.internal, `sin respuesta a ${method} en ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      writeMessage(this.output, { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    writeMessage(this.output, { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError(RPC.internal, 'conexión cerrada'));
    }
    this.pending.clear();
  }
}
