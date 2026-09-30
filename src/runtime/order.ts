import { z } from 'zod';

/**
 * Start order written by the daemon to <launch dir>/orden.json before spawning the
 * runner (v2/formatos/estado-y-protocolos.md · Runner). No secret values inside:
 * credential files are referenced by path and read by the runner only to redact.
 */
export const LaunchOrder = z
  .object({
    protocol_version: z.literal(1),
    launch_id: z.string().min(1),
    fencing_token: z.number().int().nonnegative(),
    run_id: z.string(),
    task_id: z.string(),
    attempt: z.number().int().positive(),
    provider: z.enum(['claude', 'codex', 'simulado', 'comando']),
    /** Command executed inside the sandbox (or directly, only with sandbox.mode = "ninguno" in tests). */
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()),
    cwd: z.string(),
    sandbox: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('bwrap'),
          home: z.string(),
          mounts: z.array(z.object({ src: z.string(), dest: z.string(), rw: z.boolean() }).strict()),
          read_only: z.array(z.string()),
          network_hosts: z.array(z.string()).nullable(),
          workspace_read_only: z.boolean().default(false),
        })
        .strict(),
      /**
       * Same contract as `bwrap` (ADR-012): the runner starts the task inside a
       * container instead of a bubblewrap namespace. Used when the host isn't Linux,
       * or on Linux when bwrap itself isn't usable (e.g. AppArmor blocking user
       * namespaces).
       */
      z
        .object({
          mode: z.literal('docker'),
          home: z.string(),
          mounts: z.array(z.object({ src: z.string(), dest: z.string(), rw: z.boolean() }).strict()),
          read_only: z.array(z.string()),
          network_hosts: z.array(z.string()).nullable(),
          workspace_read_only: z.boolean().default(false),
        })
        .strict(),
      /** Only for Forja's own tests: runs the command without isolation. */
      z.object({ mode: z.literal('ninguno') }).strict(),
      /**
       * Ligera edition (ADR-016): no sandbox of Forja's own. The agent runs as the
       * user, in its own worktree, limited only by its CLI's permissions. Unlike
       * «ninguno», the runner owns the whole process tree (kills it on cancel/timeout).
       */
      z.object({ mode: z.literal('directo') }).strict(),
    ]),
    timeout_ms: z.number().int().positive(),
    kill_grace_ms: z.number().int().positive().default(5000),
    redact_files: z.array(z.string()).default([]),
    stdin_text: z.string().optional(),
    /**
     * Variables that are secrets (a test database's password): they are not in this order
     * but in this file, which the runner reads, deletes and redacts from every line.
     * Only for profile commands (tests), never for an agent.
     */
    secret_env_file: z.string().optional(),
  })
  .strict();
export type LaunchOrder = z.infer<typeof LaunchOrder>;

export const LaunchResult = z
  .object({
    launch_id: z.string(),
    status: z.enum(['terminado', 'cancelado', 'tiempo_agotado', 'error_inicio']),
    exit_code: z.number().int().nullable(),
    signal: z.string().nullable(),
    started_at: z.string(),
    ended_at: z.string(),
    last_seq: z.number().int().nonnegative(),
    detail: z.string().optional(),
  })
  .strict();
export type LaunchResult = z.infer<typeof LaunchResult>;

/** One line of spool.jsonl. `seq` is strictly increasing per launch. */
export type SpoolRecord = {
  seq: number;
  ts: string;
  stream: 'stdout' | 'stderr' | 'forja';
  line: string;
};

export const FILES = {
  order: 'orden.json',
  runner: 'runner.json',
  spool: 'spool.jsonl',
  result: 'resultado.json',
  heartbeat: 'latido',
  lock: 'runner.lock',
  proxy: 'proxy.sock',
  /** Written by `cancelLaunch`: Windows has no SIGTERM, so the runner also polls for it. */
  cancel: 'cancelar',
  /** Pid of the agent process in «directo» mode, to kill a tree left behind by a dead runner. */
  agent: 'agente.json',
} as const;
