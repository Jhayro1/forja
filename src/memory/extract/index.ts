import { extname } from 'node:path';
import { goExtractor } from './go.js';
import { javaExtractor } from './java.js';
import { pythonExtractor } from './python.js';
import { rustExtractor } from './rust.js';
import type { LanguageExtractor } from './types.js';
import { typescriptExtractor } from './typescript.js';

/** Registered languages (one matrix of fixtures per language, v2/11 · V2-062). */
export const EXTRACTORS: readonly LanguageExtractor[] = [typescriptExtractor, pythonExtractor, goExtractor, rustExtractor, javaExtractor];

export function extractorFor(path: string): LanguageExtractor | null {
  const ext = extname(path);
  return EXTRACTORS.find((e) => e.extensions.includes(ext)) ?? null;
}
