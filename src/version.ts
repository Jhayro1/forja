import { readFileSync } from 'node:fs';

/** Version of this Forja build (from package.json, which ships with the package). */
export const FORJA_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
