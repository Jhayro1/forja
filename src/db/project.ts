import type { Engine } from '../core/engine.js';
import { DbConnectionStore } from './connections.js';
import { DbService } from './service.js';

/** The project's database service: the user's connections (~/.forja) and this project's rules and registry. */
export function dbServiceFor(engine: Engine, home: string): DbService {
  return new DbService(engine, new DbConnectionStore(home));
}

/** The linked databases' schema for the planner; never breaks a planner turn (null on any problem). */
export async function databasesForPrompt(engine: Engine, home: string | undefined): Promise<object | null> {
  if (!home) return null;
  try {
    return await dbServiceFor(engine, home).schemaForPrompt();
  } catch {
    return null;
  }
}
