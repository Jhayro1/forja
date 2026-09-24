import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeLine } from '../providers/claude-parser.js';
import { CodexParser } from '../providers/codex-parser.js';
import type { ProviderEvent } from '../providers/normalized.js';
import { FILES, type SpoolRecord } from '../runtime/order.js';

/**
 * What an agent is doing, read from its launch spool. Pure observation: nothing
 * here decides anything, and every line shown was already redacted by the runner.
 */
export type AgentActivity = {
  /** Last meaningful action, e.g. «Write src/uc-001.ts» or «shell npm test». */
  current: string | null;
  startedAt: string | null;
  lastAt: string | null;
  tokens: number | null;
  /**
   * Where `tokens` comes from (v2/10): «medido» when the provider reported usage,
   * «estimado» from the text exchanged so far (Codex only reports at the end of a
   * turn), «desconocido» when there is nothing to go on yet.
   */
  tokensKind: 'medido' | 'estimado' | 'desconocido';
};

/** Last `maxBytes` of the spool, whole records only (a cut first line is dropped). */
export function readSpoolTail(dir: string, maxBytes = 64 * 1024): SpoolRecord[] {
  const path = join(dir, FILES.spool);
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const out: SpoolRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SpoolRecord);
      } catch {
        // A partial record at the cut point is not an error of the launch.
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

type Parser = (line: unknown) => ProviderEvent[];

function parserFor(provider: string | null): Parser {
  if (provider === 'codex') {
    const codex = new CodexParser();
    return (line) => codex.parseLine(line);
  }
  // Claude and the simulated agent share the stream-json format.
  return parseClaudeLine;
}

function eventsOf(records: SpoolRecord[], provider: string | null): { record: SpoolRecord; events: ProviderEvent[] }[] {
  const parse = parserFor(provider);
  return records.map((record) => {
    if (record.stream !== 'stdout') return { record, events: [] };
    try {
      return { record, events: parse(JSON.parse(record.line)) };
    } catch {
      return { record, events: [] };
    }
  });
}

const oneLine = (text: string, max = 160) => text.replace(/\s+/g, ' ').trim().slice(0, max);

function describe(e: ProviderEvent): string | null {
  switch (e.t) {
    case 'herramienta':
      return oneLine(`${e.name} ${e.summary}`);
    case 'texto':
      return oneLine(e.text) || null;
    case 'resultado':
      return 'terminó';
    case 'error':
      return oneLine(`error: ${e.error.message}`);
    case 'segundo_plano':
      return oneLine(`segundo plano: ${e.description}`);
    default:
      return null;
  }
}

/** Rough token estimate from characters (≈4 per token): only shown as «estimado». */
const estimateTokens = (chars: number) => Math.round(chars / 4);

/**
 * Incremental reader of one launch spool (MEJORAS 2.7): it keeps its byte
 * offset and the parser state, so a refresh reads only what was appended since
 * the last one — and a stateful parser (Codex) sees the whole stream in order.
 */
export class SpoolFollower {
  private offset = 0;
  private carry = '';
  private readonly parse: Parser;
  private current: string | null = null;
  private startedAt: string | null = null;
  private lastAt: string | null = null;
  private measured: number | null = null;
  private summed = 0;
  private chars = 0;

  constructor(
    private readonly dir: string,
    provider: string | null,
  ) {
    this.parse = parserFor(provider);
    const prompt = launchPrompt(dir);
    this.chars = prompt?.length ?? 0;
  }

  /** Reads what was appended since the last call and returns the updated activity. */
  poll(): AgentActivity {
    const path = join(this.dir, FILES.spool);
    if (existsSync(path)) {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size < this.offset) this.reset();
        if (size > this.offset) {
          const buffer = Buffer.alloc(size - this.offset);
          readSync(fd, buffer, 0, buffer.length, this.offset);
          this.offset = size;
          const text = this.carry + buffer.toString('utf8');
          const cut = text.lastIndexOf('\n');
          this.carry = text.slice(cut + 1);
          for (const line of text.slice(0, cut + 1).split('\n')) if (line) this.consume(line);
        }
      } finally {
        closeSync(fd);
      }
    }
    return this.activity();
  }

  private reset(): void {
    this.offset = 0;
    this.carry = '';
    this.current = null;
    this.startedAt = null;
    this.lastAt = null;
    this.measured = null;
    this.summed = 0;
  }

  private consume(line: string): void {
    let record: SpoolRecord;
    try {
      record = JSON.parse(line) as SpoolRecord;
    } catch {
      return;
    }
    this.startedAt ??= record.ts;
    this.lastAt = record.ts;
    if (record.stream !== 'stdout') return;
    let events: ProviderEvent[] = [];
    try {
      events = this.parse(JSON.parse(record.line));
    } catch {
      return;
    }
    for (const e of events) {
      const d = describe(e);
      if (d) this.current = d;
      if (e.t === 'texto') this.chars += e.text.length;
      if (e.t === 'herramienta') this.chars += e.summary.length;
      if (e.t === 'uso') {
        const n = (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
        if (e.usage.semantics === 'acumulado_sesion') this.measured = n;
        else {
          this.summed += n;
          this.measured = this.summed;
        }
      }
    }
  }

  private activity(): AgentActivity {
    const base = { current: this.current, startedAt: this.startedAt, lastAt: this.lastAt };
    if (this.measured !== null) return { ...base, tokens: this.measured, tokensKind: 'medido' };
    if (this.chars > 0 && this.startedAt) return { ...base, tokens: estimateTokens(this.chars), tokensKind: 'estimado' };
    return { ...base, tokens: null, tokensKind: 'desconocido' };
  }
}

/** Followers per launch, shared by every refresh of this process (bounded). */
const followers = new Map<string, SpoolFollower>();
const MAX_FOLLOWERS = 128;

export function agentActivity(dir: string | null, provider: string | null): AgentActivity {
  if (!dir) return { current: null, startedAt: null, lastAt: null, tokens: null, tokensKind: 'desconocido' };
  const key = `${dir}|${provider ?? ''}`;
  let f = followers.get(key);
  if (!f) {
    if (followers.size >= MAX_FOLLOWERS) followers.delete(followers.keys().next().value!);
    f = new SpoolFollower(dir, provider);
    followers.set(key, f);
  }
  return f.poll();
}

/** Human-readable log of a launch: provider events translated, runner lines kept. */
export function readableLog(records: SpoolRecord[], provider: string | null): { seq: number; ts: string; text: string }[] {
  const out: { seq: number; ts: string; text: string }[] = [];
  for (const { record, events } of eventsOf(records, provider)) {
    if (record.stream !== 'stdout') {
      out.push({ seq: record.seq, ts: record.ts, text: `${record.stream === 'forja' ? '·' : '!'} ${record.line}` });
      continue;
    }
    for (const e of events) {
      const text =
        e.t === 'texto'
          ? `» ${oneLine(e.text, 400)}`
          : e.t === 'herramienta'
            ? `⚙ ${oneLine(`${e.name} ${e.summary}`, 400)}${e.exitCode ? ` (salida ${e.exitCode})` : ''}`
            : e.t === 'resultado'
              ? `✔ ${oneLine(e.text, 400) || 'resultado'}`
              : e.t === 'error'
                ? `✘ ${e.error.message}`
                : e.t === 'segundo_plano'
                  ? `⚠ segundo plano: ${e.description}`
                  : e.t === 'inicio'
                    ? `▶ sesión ${e.sessionId.slice(0, 8)}${e.model ? ` · ${e.model}` : ''}`
                    : null;
      if (text) out.push({ seq: record.seq, ts: record.ts, text });
    }
  }
  return out;
}

/**
 * Files an agent opened by itself during a launch (Read tools, or shell
 * commands naming a project file). Used to evaluate context selectors against
 * what agents really needed, not against what a selector thinks they need.
 */
export function filesReadBy(dir: string, provider: string | null, tree: readonly string[]): string[] {
  const known = new Set(tree);
  const found = new Set<string>();
  const match = (raw: string) => {
    const clean = raw.replace(/^["']|["']$/g, '');
    if (known.has(clean)) return found.add(clean);
    // Absolute paths inside the worktree: keep the longest suffix that is a project file.
    const parts = clean.split('/');
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join('/');
      if (known.has(tail)) return found.add(tail);
    }
    return undefined;
  };
  for (const { events } of eventsOf(readSpoolTail(dir, 4 * 1024 * 1024), provider)) {
    for (const e of events) {
      if (e.t !== 'herramienta') continue;
      if (/^(Read|read_file|View)$/i.test(e.name)) match(e.summary);
      else if (/^(shell|Bash)$/i.test(e.name) && /\b(cat|sed|head|tail|less|nl|grep|rg)\b/.test(e.summary)) for (const tok of e.summary.split(/\s+/)) match(tok);
    }
  }
  return [...found].sort();
}

/** The exact instructions the agent received (the order holds no secret values). */
export function launchPrompt(dir: string | null): string | null {
  if (!dir) return null;
  const path = join(dir, FILES.order);
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { stdin_text?: string }).stdin_text ?? null;
  } catch {
    return null;
  }
}
