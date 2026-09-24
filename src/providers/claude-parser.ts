import type { NormalizedError } from '../domain/errors.js';
import type { ProviderEvent, Usage } from './normalized.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Maps one `claude -p --output-format stream-json --verbose` line to observations.
 * Shapes verified in M0 (Claude Code 2.1.281, m0/fixtures/claude-*.jsonl).
 */
export function parseClaudeLine(line: unknown): ProviderEvent[] {
  if (!isObj(line)) return [{ t: 'desconocido', rawType: typeof line }];
  const type = str(line.type) ?? '?';
  const subtype = str(line.subtype);

  if (type === 'system') {
    if (subtype === 'init') return [{ t: 'inicio', sessionId: str(line.session_id) ?? '', model: str(line.model) }];
    if (subtype === 'task_started' && line.is_backgrounded === true) {
      return [{ t: 'segundo_plano', description: str(line.description) ?? '' }];
    }
    return [];
  }

  if (type === 'assistant' && isObj(line.message) && Array.isArray(line.message.content)) {
    const out: ProviderEvent[] = [];
    for (const block of line.message.content) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) out.push({ t: 'texto', text: block.text });
      if (block.type === 'tool_use') {
        out.push({ t: 'herramienta', name: str(block.name) ?? '?', summary: summarizeInput(block.input) });
      }
    }
    return out;
  }

  if (type === 'user') return [];

  if (type === 'result') {
    const out: ProviderEvent[] = [];
    const usage = isObj(line.usage) ? line.usage : {};
    const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {};
    const cost = num(line.total_cost_usd);
    const u: Usage = {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: num(details.thinking_tokens),
      costEquivalentMicroUsd: cost === null ? null : Math.round(cost * 1_000_000),
      semantics: 'acumulado_sesion',
    };
    out.push({ t: 'uso', usage: u });
    // M0 finding: a 429 arrives with subtype "success" and is_error true. Classify by is_error.
    if (line.is_error === true) {
      out.push({ t: 'error', error: classifyClaudeError(line) });
    } else {
      out.push({ t: 'resultado', text: str(line.result) ?? '', ...(line.structured_output !== undefined ? { structured: line.structured_output } : {}) });
    }
    return out;
  }

  return [{ t: 'desconocido', rawType: subtype ? `${type}.${subtype}` : type }];
}

function classifyClaudeError(line: Obj): NormalizedError {
  const status = num(line.api_error_status);
  const code = str(line.api_error_code) ?? undefined;
  const message = str(line.result) ?? str(line.terminal_reason) ?? 'error del proveedor';
  const base = code ? { providerCode: code } : {};
  if (status === 429 || code === 'credits_required' || /usage (credits|limit)/i.test(message)) {
    return { category: 'quota', message, retryable: true, ...base };
  }
  if (status === 401 || status === 403 || /log ?in|authenticat/i.test(message)) return { category: 'auth', message, retryable: false, ...base };
  if (status !== null && status >= 500) return { category: 'network', message, retryable: true, ...base };
  return { category: 'unknown', message, retryable: false, ...base };
}

function summarizeInput(input: unknown): string {
  if (!isObj(input)) return '';
  const first = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description;
  const text = typeof first === 'string' ? first : JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
