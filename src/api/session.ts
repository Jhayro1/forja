import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Local sessions for the panel (v2/06): a one-time login code shown in the
 * terminal becomes an HttpOnly cookie plus a CSRF token. Nothing is persisted:
 * restarting `forja ui` logs everyone out, which is the safe default for a
 * loopback-only tool.
 */
export type Session = { id: string; csrf: string; expiresAt: number };

const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class SessionManager {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly opts: { codeTtlMs?: number; sessionTtlMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** New single-use login code (expires quickly: it travels through the terminal). */
  issueCode(): string {
    const code = token(24);
    this.codes.set(code, this.now() + (this.opts.codeTtlMs ?? 5 * 60_000));
    return code;
  }

  /** Exchanges a valid code for a session. The code can never be used again. */
  exchange(code: string): Session | null {
    let match: string | null = null;
    for (const known of this.codes.keys()) if (safeEqual(known, code)) match = known;
    if (!match) return null;
    const expires = this.codes.get(match)!;
    this.codes.delete(match);
    if (expires < this.now()) return null;
    const session: Session = { id: token(), csrf: token(), expiresAt: this.now() + (this.opts.sessionTtlMs ?? 12 * 3_600_000) };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    for (const [known, session] of this.sessions) {
      if (!safeEqual(known, id)) continue;
      if (session.expiresAt < this.now()) {
        this.sessions.delete(known);
        return null;
      }
      return session;
    }
    return null;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }
}
