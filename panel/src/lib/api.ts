/**
 * Cliente de la API local de Forja (mismo origen que el panel).
 * - Sesión por cookie + token CSRF en cada mutación.
 * - Lecturas con ETag: un 304 devuelve lo último leído, sin volver a transferirlo.
 * - Cada mutación lleva su Idempotency-Key: repetir un clic no repite el efecto.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

type Cached = { etag: string; data: unknown };

export class ApiClient {
  private csrf = '';
  private readonly cache = new Map<string, Cached>();

  setCsrf(token: string): void {
    this.csrf = token;
  }

  async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);
    const res = await fetch(path, { credentials: 'same-origin', headers: cached ? { 'If-None-Match': cached.etag } : {} });
    if (res.status === 304 && cached) return cached.data as T;
    const data = await this.parse(res);
    const etag = res.headers.get('ETag');
    if (etag) this.cache.set(path, { etag, data });
    return data as T;
  }

  async post<T>(path: string, body: object = {}): Promise<T> {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Forja-CSRF': this.csrf, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return (await this.parse(res)) as T;
  }

  /** Forget cached reads (after switching project, everything changes). */
  clear(): void {
    this.cache.clear();
  }

  private async parse(res: Response): Promise<unknown> {
    const data = (await res.json().catch(() => ({}))) as { error?: { mensaje?: string; codigo?: string } };
    if (!res.ok) throw new ApiError(data.error?.mensaje ?? `error ${res.status}`, res.status, data.error?.codigo);
    return data;
  }
}

export const api = new ApiClient();

/** The one-time code travels in the URL fragment (never reaches the server or its logs). */
export function takeLinkCode(): string | null {
  const match = /(?:^|&)codigo=([^&]+)/.exec(location.hash.slice(1));
  if (!match?.[1]) return null;
  history.replaceState(null, '', location.pathname);
  return decodeURIComponent(match[1]);
}

/** Opens (with a link code) or resumes (with the cookie) the panel session. */
export async function startSession(code: string | null): Promise<void> {
  const r = code ? await api.post<{ csrf: string }>('/v1/sesion', { codigo: code }) : await api.get<{ csrf: string }>('/v1/sesion');
  api.setCsrf(r.csrf);
}
