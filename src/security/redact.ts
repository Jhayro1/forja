/**
 * Redaction is a second line of defense (R04): the first is never giving secrets
 * to agents. Applied before persisting and before showing anything.
 */

const MIN_SECRET_LENGTH = 8;

/** Well-known credential shapes, redacted even when Forja does not know the value. */
const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'llave_privada', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer', re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g },
];

export type SecretEntry = { name: string; value: string };

export class Redactor {
  private readonly needles: { needle: string; label: string }[] = [];

  constructor(secrets: readonly SecretEntry[] = []) {
    for (const s of secrets) this.add(s);
  }

  add({ name, value }: SecretEntry): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    const label = `«secreto:${name}»`;
    const variants = new Set([value, Buffer.from(value).toString('base64'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    for (const v of variants) if (v.length >= MIN_SECRET_LENGTH) this.needles.push({ needle: v, label });
    // Longest first so a secret containing another is replaced whole.
    this.needles.sort((a, b) => b.needle.length - a.needle.length);
  }

  needleValues(): string[] {
    return this.needles.map((n) => n.needle);
  }

  get longestNeedle(): number {
    return this.needles[0]?.needle.length ?? 0;
  }

  redact(text: string): string {
    let out = text;
    for (const { needle, label } of this.needles) out = out.split(needle).join(label);
    for (const { name, re } of PATTERNS) {
      out = out.replace(re, (match, prefix: unknown) => (name === 'bearer' && typeof prefix === 'string' ? `${prefix}«secreto»` : `«secreto:${name}»`));
    }
    return out;
  }

  /** True when the text contains a known value or a credential-shaped string. */
  containsSecret(text: string): boolean {
    if (this.needles.some(({ needle }) => text.includes(needle))) return true;
    return PATTERNS.some(({ re }) => new RegExp(re.source, re.flags.replace('g', '')).test(text));
  }

  stream(): StreamRedactor {
    return new StreamRedactor(this);
  }
}

/**
 * Emits only whole lines so a secret split across chunks is still caught. A line
 * longer than `maxHold` is cut, but never inside a known secret value; a private
 * key block is held until its END line (bounded by `maxHold`).
 */
export class StreamRedactor {
  private tail = '';

  constructor(
    private readonly redactor: Redactor,
    private readonly maxHold = 64 * 1024,
  ) {}

  push(chunk: string): string {
    const text = this.tail + chunk;
    let cut = text.lastIndexOf('\n') + 1;
    const keyStart = openPrivateKey(text.slice(0, cut));
    if (keyStart >= 0) cut = keyStart;
    if (cut === 0 && text.length > this.maxHold) cut = this.safeCut(text, text.length - this.redactor.longestNeedle);
    this.tail = text.slice(cut);
    return cut > 0 ? this.redactor.redact(text.slice(0, cut)) : '';
  }

  end(): string {
    const out = this.redactor.redact(this.tail);
    this.tail = '';
    return out;
  }

  /** Moves `at` back so no known needle straddles the cut. */
  private safeCut(text: string, at: number): number {
    let cut = Math.max(0, at);
    for (const needle of this.redactor.needleValues()) {
      let from = Math.max(0, cut - needle.length + 1);
      let i: number;
      while ((i = text.indexOf(needle, from)) >= 0 && i < cut) {
        if (i + needle.length > cut) cut = i;
        from = i + 1;
      }
    }
    return cut;
  }
}

function openPrivateKey(text: string): number {
  const begin = text.lastIndexOf('-----BEGIN ');
  if (begin < 0 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text.slice(begin))) return -1;
  return /-----END [A-Z ]*PRIVATE KEY-----/.test(text.slice(begin)) ? -1 : text.lastIndexOf('\n', begin) + 1;
}
