import { z } from 'zod';
import { hashJson } from '../domain/hash.js';

/**
 * Runtime policy for one launch. The repo can only REQUEST (forja.yaml is untrusted);
 * the effective policy is the intersection with what the user approved locally (v2/05, v2/06).
 */
export const NetworkPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ninguna') }).strict(),
  /** Only the provider API, through Forja's proxy (D2-20). */
  z.object({ mode: z.literal('proveedor') }).strict(),
  /** Provider plus explicit hosts, e.g. registry.npmjs.org for an install task. */
  z.object({ mode: z.literal('lista'), hosts: z.array(z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i)).min(1) }).strict(),
]);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const RuntimePolicy = z
  .object({
    network: NetworkPolicy,
    /** Tools the agent may use (provider names are mapped by each adapter). */
    tools: z.array(z.string()).min(1),
    write_globs: z.array(z.string()).min(1),
    protected_paths: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive(),
    max_memory_mb: z.number().int().positive().default(2048),
  })
  .strict();
export type RuntimePolicy = z.infer<typeof RuntimePolicy>;

const NET_RANK = { ninguna: 0, proveedor: 1, lista: 2 } as const;

/** Result never grants more than `approved`, whatever `requested` asks for. */
export function intersectPolicy(requested: RuntimePolicy, approved: RuntimePolicy): RuntimePolicy {
  let network: NetworkPolicy;
  if (NET_RANK[requested.network.mode] <= NET_RANK[approved.network.mode]) {
    if (requested.network.mode === 'lista') {
      const allowed = approved.network.mode === 'lista' ? new Set(approved.network.hosts) : new Set<string>();
      const hosts = requested.network.hosts.filter((h) => allowed.has(h));
      network = hosts.length > 0 ? { mode: 'lista', hosts } : { mode: 'proveedor' };
    } else {
      network = requested.network;
    }
  } else {
    network = approved.network.mode === 'lista' ? { mode: 'proveedor' } : approved.network;
  }
  const approvedTools = new Set(approved.tools);
  const tools = requested.tools.filter((t) => approvedTools.has(t));
  if (tools.length === 0) throw new Error('la política efectiva no deja ninguna herramienta');
  return {
    network,
    tools,
    // Globs cannot be intersected exactly; keep requested ones that were approved verbatim.
    write_globs: requested.write_globs.filter((g) => approved.write_globs.includes(g)),
    protected_paths: [...new Set([...approved.protected_paths, ...requested.protected_paths])],
    timeout_ms: Math.min(requested.timeout_ms, approved.timeout_ms),
    max_memory_mb: Math.min(requested.max_memory_mb, approved.max_memory_mb),
  };
}

export function policyHash(policy: RuntimePolicy): string {
  return hashJson(policy);
}
