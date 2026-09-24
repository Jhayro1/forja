import type { Confidence } from '../graph-store.js';

/**
 * Contract of a language extractor (V2-060/062). Adding a language is adding
 * one implementation to the registry: the graph builder and the selector do
 * not change. Extractors are syntactic: what they cannot prove is marked
 * «posible» or reported as a limitation, never guessed as certain.
 */
/** `imported`: the name in the target module ('default', '*' for a namespace); `local`: the name here. */
export type ImportedName = { imported: string; local: string };
export type ImportRef = {
  specifier: string;
  confidence: Confidence;
  line: number;
  /** Named bindings, when the syntax says which (lets the graph follow a symbol through barrels). */
  names?: ImportedName[];
  /** A re-export: `export { a as b } from` («names») or `export * from` («all»). */
  reexport?: 'names' | 'all';
};
export type SymbolRef = { name: string; kind: 'funcion' | 'clase' | 'variable' | 'tipo'; exported: boolean; line: number };

export type Extraction = {
  imports: ImportRef[];
  symbols: SymbolRef[];
  /** Spec ids mentioned anywhere (tests name their criteria; code may cite rules). */
  mentions: string[];
  /** Limitations found in this file, shown to the user. */
  notes: string[];
  /** Local names bound by imports that the file really uses (outside the import itself). */
  used?: string[];
};

/**
 * Project-level resolution data (MEJORAS 5.3): tsconfig `paths`/`baseUrl`,
 * package.json `imports` (#x), workspace packages and their `exports`, the Go
 * module path. Built once per graph build from versioned files.
 */
export type ResolveContext = {
  /** tsconfig paths: pattern (with at most one *) → targets relative to the repo root. */
  aliases: { pattern: string; targets: string[] }[];
  baseUrl: string | null;
  /** package.json "imports" of the root package: "#x" → path. */
  packageImports: Record<string, string>;
  /** Workspace package name → { dir, exports: subpath → path } (paths relative to the repo root). */
  workspaces: Record<string, { dir: string; exports: Record<string, string> }>;
  /** go.mod `module` line. */
  goModule: string | null;
};

export const EMPTY_RESOLVE_CONTEXT: ResolveContext = { aliases: [], baseUrl: null, packageImports: {}, workspaces: {}, goModule: null };

export type Resolution = { path: string; confidence: Confidence } | { package: string } | null;

export interface LanguageExtractor {
  readonly id: string;
  /** Changing it invalidates every file analyzed with the previous version. */
  readonly version: string;
  readonly extensions: readonly string[];
  extract(text: string): Extraction;
  resolve(specifier: string, fromPath: string, files: ReadonlySet<string>, ctx?: ResolveContext): Resolution;
}

/** Spec ids (v2 formats). Longest alternatives first so CA-UC-… is not read as UC-…. */
export const SPEC_ID_RE = /\b(?:CA-UC-\d{3}-\d{2}|UC-\d{3}|REQ-\d{3}|RNF-\d{3}|CT-\d{3}|R-\d{3}|E-\d{3}|T-\d{3})\b/g;

export function mentionsIn(text: string): string[] {
  return [...new Set(text.match(SPEC_ID_RE) ?? [])].sort();
}
