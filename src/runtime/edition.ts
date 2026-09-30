/**
 * Which Forja this is (ligera/PLAN.md §2). One code base, two editions:
 *  - «completa»: several agents in parallel, each inside Forja's own sandbox
 *    (bwrap/Docker); Linux, WSL or a server.
 *  - «ligera»: one agent per task or block, on the user's own machine (Windows,
 *    macOS or Linux) with the Claude/Codex CLIs already installed there, WITHOUT
 *    Forja's sandbox («directo» mode).
 * The ligera package's bin sets FORJA_EDICION=ligera before loading the CLI.
 */
export type Edition = 'completa' | 'ligera';

export function edition(env: NodeJS.ProcessEnv = process.env): Edition {
  return env.FORJA_EDICION === 'ligera' ? 'ligera' : 'completa';
}

export const isLigera = (env: NodeJS.ProcessEnv = process.env): boolean => edition(env) === 'ligera';
