import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { hashJson } from '../domain/hash.js';

export const CONFIG_FILE = 'forja.yaml';

const ModelRef = z.string().regex(/^(claude|codex|simulado):[A-Za-z0-9._-]+$/, 'formato proveedor:modelo, p. ej. claude:haiku');

const CommandRecipe = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().default('.'),
  })
  .strict();
export type CommandRecipe = z.infer<typeof CommandRecipe>;

/**
 * forja.yaml (v2/formatos/especificacion-y-configuracion.md). It is a REQUEST from
 * the repo: it never grants itself sandbox, secrets or budget. Unknown keys are errors.
 */
export const ForjaConfig = z
  .object({
    schema_version: z.literal(1),
    project_id: z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/),
    nombre: z.string().min(1).max(80),
    roles: z
      .object({
        planeador: z.array(ModelRef).min(1).default(['claude:opus', 'codex:gpt-6-astra']),
        trabajador: z.array(ModelRef).min(1).default(['claude:haiku', 'codex:gpt-6-luna']),
        complejo: z.array(ModelRef).min(1).default(['claude:sonnet', 'codex:gpt-6-sol']),
        revisor: z.array(ModelRef).min(1).default(['codex:gpt-6-sol', 'claude:sonnet']),
      })
      .strict()
      .prefault({}),
    ejecucion: z
      .object({
        paralelo: z.number().int().min(1).max(16).default(3),
        timeout_min: z.number().int().min(1).max(240).default(30),
        intentos_calidad: z.number().int().min(1).max(6).default(3),
      })
      .strict()
      .prefault({}),
    presupuesto: z
      .object({
        por_tarea_usd: z.number().positive().default(1),
        por_run_usd: z.number().positive().default(20),
      })
      .strict()
      .prefault({}),
    perfil: z
      .object({
        stack: z.array(z.string()).default([]),
        gestor: z.string().optional(),
        comandos: z.partialRecord(z.enum(['instalar', 'build', 'typecheck', 'lint', 'test']), CommandRecipe).default({}),
        red_instalar: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    contexto: z
      .object({
        /** «grafo» adds related files from the knowledge graph; enable it after `forja memoria evaluar` shows it helps. */
        modo: z.enum(['simple', 'grafo']).default('simple'),
        max_archivos: z.number().int().min(1).max(50).default(15),
        /** Offer the MCP tool pedir_contexto to workers (it enables the gateway even without connections). */
        bajo_pedido: z.boolean().default(false),
        /** Local lexical locator of entry points (no network); embeddings are not offered until provider and privacy are decided. */
        buscador: z.enum(['ninguno', 'lexico']).default('ninguno'),
      })
      .strict()
      .prefault({}),
    conexiones: z.array(z.string()).default([]),
    git: z
      .object({
        rama_principal: z.string().default('main'),
        prefijo: z
          .string()
          .regex(/^[a-z0-9-]+\/$/)
          .default('forja/'),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type ForjaConfig = z.infer<typeof ForjaConfig>;

export class ConfigError extends Error {}

export function readConfig(repoRoot: string): ForjaConfig {
  const path = join(repoRoot, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`no se pudo leer ${path}: ${(error as Error).message}`);
  }
  const result = ForjaConfig.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${path} no es válido:\n${issues}`);
  }
  return result.data;
}

export function writeConfig(repoRoot: string, config: ForjaConfig): void {
  const header = '# Configuración de Forja. Sin secretos: las credenciales viven en la bóveda local.\n';
  writeFileSync(join(repoRoot, CONFIG_FILE), header + stringify(config, { lineWidth: 0 }));
}

export function configHash(config: ForjaConfig): string {
  return hashJson(config);
}

/** Walks up from `start` looking for forja.yaml. */
export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
