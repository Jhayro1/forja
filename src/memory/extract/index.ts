import { extname } from 'node:path';
import { pythonExtractor } from './python.js';
import type { LanguageExtractor } from './types.js';
import { typescriptExtractor } from './typescript.js';

/** Registered languages (one matrix of fixtures per language, v2/11 · V2-062). */
export const EXTRACTORS: readonly LanguageExtractor[] = [typescriptExtractor, pythonExtractor];

export function extractorFor(path: string): LanguageExtractor | null {
  const ext = extname(path);
  return EXTRACTORS.find((e) => e.extensions.includes(ext)) ?? null;
}
