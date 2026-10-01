import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes } from '../domain/hash.js';

/** prompts/ lives at the package root, next to src/ and dist/. */
function promptsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'prompts');
    if (existsSync(join(candidate, 'planeador'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('no se encontró la carpeta prompts/ del paquete');
}

export type PromptPart = { id: string; text: string; hash: string };

const cache = new Map<string, PromptPart>();

export function loadPrompt(id: string): PromptPart {
  const cached = cache.get(id);
  if (cached) return cached;
  const raw = readFileSync(join(promptsRoot(), `${id}.md`), 'utf8');
  const text = raw.replace(/^<!--[\s\S]*?-->\n?/, '').trim();
  const part = { id, text, hash: hashBytes(raw) };
  cache.set(id, part);
  return part;
}

/** Joins instruction parts and data blocks; returns the manifest of prompt versions used. */
export function compose(parts: PromptPart[], data: Record<string, unknown>): { prompt: string; manifest: Record<string, string> } {
  const sections = parts.map((p) => p.text);
  for (const [tag, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const body = typeof value === 'string' ? value : JSON.stringify(value); // compact: indentation only costs tokens
    // Data is delimited so text coming from the repo or the user is not read as Forja's instructions.
    sections.push(`<${tag}>\n${body.replaceAll(`</${tag}>`, `<\\/${tag}>`)}\n</${tag}>`);
  }
  return { prompt: sections.join('\n\n'), manifest: Object.fromEntries(parts.map((p) => [p.id, p.hash])) };
}
