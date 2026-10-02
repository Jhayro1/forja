import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../core/engine.js';
import { activeChange, type ChangeRow, SELECTION_FILE as FILE, getChange, listChanges, PlannerError } from './session.js';

/**
 * Several sprints can live at once (flujo/PLAN.md §4): every surface works on the
 * selected one. The choice is an interface preference per project (a file in its data
 * folder), not a domain fact; `FORJA_CAMBIO` pins it for one command (the panel's jobs).
 */
export function selectedChange(engine: Engine): ChangeRow | undefined {
  const pinned = process.env.FORJA_CAMBIO?.trim();
  if (pinned) return findChange(engine, pinned);
  let chosen: string | null = null;
  try {
    chosen = readFileSync(join(engine.dataDir, FILE), 'utf8').trim();
  } catch {
    // Nothing chosen yet.
  }
  const all = listChanges(engine);
  return all.find((c) => c.change_id === chosen) ?? activeChange(engine) ?? all[0];
}

export function selectChange(engine: Engine, changeId: string): ChangeRow {
  const change = getChange(engine, changeId);
  writeFileSync(join(engine.dataDir, FILE), change.change_id);
  return change;
}

/** A finished sprint (delivered or cancelled) is only read: new work starts a new sprint. */
export function isClosed(change: ChangeRow): boolean {
  return change.phase === 'entregado' || change.phase === 'cancelado';
}

/**
 * A sprint named the way the user types it: its id, a unique piece of it, or its number
 * in `forja cambios` (1 = the newest).
 */
export function findChange(engine: Engine, ref: string): ChangeRow {
  const all = listChanges(engine);
  const text = ref.trim();
  const exact = all.find((c) => c.change_id === text);
  if (exact) return exact;
  if (/^\d+$/.test(text)) {
    const row = all[Number(text) - 1];
    if (row) return row;
  }
  const lower = text.toLowerCase();
  const matches = all.filter((c) => c.change_id.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new PlannerError(`«${ref}» coincide con ${matches.length} sprints: usa más letras del id`);
  throw new PlannerError(`no existe el sprint «${ref}»: mira la lista con forja cambios (y elige uno con forja sprint <número>)`);
}
