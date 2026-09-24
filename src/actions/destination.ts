import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where an action may go (v2/06). Resolved once and pinned: the address checked
 * is the address used (no DNS rebinding between check and connection), and
 * private, loopback and metadata ranges are refused unless the connection
 * explicitly allows local test services.
 */

export function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}

export class DestinationError extends Error {
  constructor(
    message: string,
    readonly kind: 'bloqueado' | 'no_enviado',
  ) {
    super(message);
  }
}

export const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
export const portOf = (url: URL) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80);

/** Resolves and checks a destination; throws DestinationError («bloqueado» or «no_enviado»). */
export async function pinDestination(url: URL, allowLocal: boolean): Promise<string> {
  const host = hostOf(url);
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch (e) {
    throw new DestinationError(`no se pudo resolver ${host}: ${(e as Error).message}`, 'no_enviado');
  }
  if (!addresses.length) throw new DestinationError(`no se pudo resolver ${host}`, 'no_enviado');
  const blocked = addresses.find((a) => isPrivate(a.address));
  if (blocked && !allowLocal) throw new DestinationError(`destino interno bloqueado: ${host} → ${blocked.address}`, 'bloqueado');
  return addresses[0]!.address;
}
