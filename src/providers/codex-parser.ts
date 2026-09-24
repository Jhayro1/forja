import type { NormalizedError } from '../domain/errors.js';
import type { ProviderEvent } from './normalized.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Stateful because Codex reports the final answer as the last `agent_message`
 * and closes the turn later with `turn.completed`.
 * Shapes verified in M0 (codex-cli 0.156.1, m0/fixtures/codex-*.jsonl).
 */
export class CodexParser {
  private lastMessage: string | null = null;

  parseLine(line: unknown): ProviderEvent[] {
    if (!isObj(line)) return [{ t: 'desconocido', rawType: typeof line }];
    const type = str(line.type) ?? '?';

    switch (type) {
      case 'thread.started':
        // M0: Codex does not report the effective model in its events.
        return [{ t: 'inicio', sessionId: str(line.thread_id) ?? '', model: null }];
      case 'turn.started':
      case 'item.started':
      case 'item.updated':
        return [];
      case 'item.completed': {
        const item = isObj(line.item) ? line.item : {};
        if (item.type === 'agent_message') {
          const text = str(item.text) ?? '';
          this.lastMessage = text;
          return [{ t: 'texto', text }];
        }
        if (item.type === 'command_execution') {
          return [{ t: 'herramienta', name: 'shell', summary: str(item.command) ?? '', exitCode: num(item.exit_code) }];
        }
        if (item.type === 'reasoning') return [];
        return [{ t: 'herramienta', name: str(item.type) ?? '?', summary: '' }];
      }
      case 'turn.completed': {
        const usage = isObj(line.usage) ? line.usage : {};
        return [
          {
            t: 'uso',
            usage: {
              inputTokens: num(usage.input_tokens),
              outputTokens: num(usage.output_tokens),
              cacheReadTokens: num(usage.cached_input_tokens),
              cacheWriteTokens: num(usage.cache_write_input_tokens),
              reasoningTokens: num(usage.reasoning_output_tokens),
              costEquivalentMicroUsd: null,
              semantics: 'por_turno',
            },
          },
          { t: 'resultado', text: this.lastMessage ?? '' },
        ];
      }
      case 'turn.failed':
      case 'error': {
        const err = isObj(line.error) ? line.error : line;
        return [{ t: 'error', error: classifyCodexError(str(err.message) ?? JSON.stringify(err).slice(0, 300)) }];
      }
      default:
        return [{ t: 'desconocido', rawType: type }];
    }
  }
}

function classifyCodexError(message: string): NormalizedError {
  if (/usage limit|rate limit|quota|too many requests|429/i.test(message)) return { category: 'quota', message, retryable: true };
  if (/unauthori[sz]ed|log ?in|401|403|auth/i.test(message)) return { category: 'auth', message, retryable: false };
  if (/model.*(not|no).*(found|exist|support)/i.test(message)) return { category: 'environment', message, retryable: false };
  if (/timeout|timed out/i.test(message)) return { category: 'timeout', message, retryable: true };
  if (/network|connection|stream disconnected|5\d\d/i.test(message)) return { category: 'network', message, retryable: true };
  return { category: 'unknown', message, retryable: false };
}
