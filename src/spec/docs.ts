import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashBytes, hashJson } from '../domain/hash.js';
import type { Spec } from './spec.js';

export const TEMPLATE_VERSION = 'docs-v1';

type Doc = { path: string; sources: string[]; content: string };

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const list = (items: string[], empty = '—') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);

function header(spec: Spec, title: string): string {
  return `<!-- Generado por Forja desde spec.json (revisión ${spec.revision}). Si lo editas a mano, Forja no lo sobrescribe: deja la versión nueva al lado. -->\n# ${title}\n`;
}

function useCaseDoc(spec: Spec, uc: Spec['casos_uso'][number]): string {
  const actor = spec.actores.find((a) => a.id === uc.actor_id);
  const criteria = spec.criterios.filter((c) => c.caso_uso_id === uc.id);
  const rules = spec.reglas.filter((r) => uc.reglas.includes(r.id));
  return [
    header(spec, `${uc.id} · ${uc.nombre}`),
    `**Actor:** ${actor ? `${actor.nombre} (${actor.id})` : uc.actor_id} · **Objetivo:** ${uc.objetivo}`,
    `**Requisitos:** ${uc.requisitos.join(', ') || '—'} · **Entidades:** ${uc.entidades.join(', ') || '—'}`,
    '',
    '## Precondiciones',
    list(uc.precondiciones),
    '',
    '## Flujo principal',
    uc.pasos.map((p) => `${p.id}. ${p.texto}`).join('\n'),
    '',
    '## Flujos alternos',
    uc.alternos.length
      ? uc.alternos.map((a) => `- **${a.id}** (desde ${a.desde_paso}) · ${a.condicion}\n${a.pasos.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}${a.retorno ? `\n  → vuelve a ${a.retorno}` : ''}`).join('\n')
      : '—',
    '',
    '## Excepciones',
    uc.excepciones.length ? uc.excepciones.map((x) => `- **${x.id}** (desde ${x.desde_paso}) · ${x.condicion} → ${x.resultado}`).join('\n') : `No aplican: ${uc.excepciones_no_aplican ?? '—'}`,
    '',
    '## Postcondiciones',
    list(uc.postcondiciones),
    '',
    '## Reglas aplicadas',
    list(rules.map((r) => `**${r.id}** ${r.texto}`)),
    '',
    '## Criterios de aceptación',
    criteria.length
      ? criteria.map((c) => `- **${c.id}** (${c.tipo_evidencia})\n  - Dado ${c.dado}\n  - Cuando ${c.cuando}\n  - Entonces ${c.entonces}`).join('\n')
      : '—',
    '',
  ].join('\n');
}

function featureDoc(spec: Spec, uc: Spec['casos_uso'][number]): string {
  const criteria = spec.criterios.filter((c) => c.caso_uso_id === uc.id);
  const lines = [`# language: es`, `# Generado por Forja desde spec.json (revisión ${spec.revision})`, `Característica: ${uc.id} ${uc.nombre}`, `  ${uc.objetivo}`, ''];
  for (const c of criteria) {
    lines.push(`  @${c.id}${c.tipo_evidencia === 'manual' ? ' @manual' : ''}`, `  Escenario: ${c.id}`, `    Dado ${c.dado}`, `    Cuando ${c.cuando}`, `    Entonces ${c.entonces}`, '');
  }
  return lines.join('\n');
}

function dataModelDoc(spec: Spec): string {
  const mermaid = spec.entidades.length
    ? [
        '```mermaid',
        'erDiagram',
        ...spec.entidades.map((e) => `  ${e.nombre.replace(/\W/g, '_')} {\n${e.campos.map((f) => `    ${f.tipo.replace(/\W/g, '_') || 'dato'} ${f.nombre.replace(/\W/g, '_')}`).join('\n')}\n  }`),
        '```',
      ].join('\n')
    : '';
  const tables = spec.entidades
    .map(
      (e) =>
        `## ${e.id} · ${e.nombre}\n\n| Campo | Tipo | Requerido | Restricción |\n|---|---|---|---|\n${e.campos
          .map((f) => `| ${md(f.nombre)} | ${md(f.tipo)} | ${f.requerido ? 'sí' : 'no'} | ${md(f.restriccion ?? '')} |`)
          .join('\n')}\n\n**Invariantes:**\n${list(e.invariantes)}`,
    )
    .join('\n\n');
  return [header(spec, 'Modelo de datos'), mermaid, '', tables, ''].join('\n');
}

function traceDoc(spec: Spec, tasksByCriterion: Map<string, string[]>): string {
  const rows = spec.requisitos.map((r) => {
    const cases = spec.casos_uso.filter((u) => u.requisitos.includes(r.id)).map((u) => u.id);
    const crit = spec.criterios.filter((c) => c.requisitos.includes(r.id)).map((c) => c.id);
    const tasks = [...new Set(crit.flatMap((c) => tasksByCriterion.get(c) ?? []))];
    return `| ${r.id} | ${md(r.texto)} | ${cases.join(', ') || '—'} | ${crit.join(', ') || '—'} | ${tasks.join(', ') || '—'} |`;
  });
  return [header(spec, 'Trazabilidad'), '| Requisito | Texto | Casos de uso | Criterios | Tareas |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

function testPlanDoc(spec: Spec): string {
  const rows = spec.criterios.map((c) => `| ${c.id} | ${c.caso_uso_id} | ${c.tipo_evidencia} | ${md(c.entonces)} |`);
  const exceptions = spec.casos_uso.flatMap((u) => u.excepciones.map((x) => `| ${u.id}/${x.id} | ${md(x.condicion)} | ${md(x.resultado)} |`));
  const rnf = spec.rnf.map((r) => `| ${r.id} | ${md(r.metrica)} ${r.comparador} ${md(r.umbral)} ${md(r.unidad)} | ${md(r.escenario)} | ${md(r.metodo)} |`);
  return [
    header(spec, 'Plan de pruebas'),
    'Cada criterio automático tiene al menos una prueba; los manuales requieren evidencia y quién la acepta.',
    '',
    '## Criterios de aceptación',
    '| Criterio | Caso | Evidencia | Resultado esperado |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Excepciones a cubrir',
    '| Excepción | Condición | Resultado |',
    '|---|---|---|',
    ...(exceptions.length ? exceptions : ['| — | — | — |']),
    '',
    '## Requisitos no funcionales',
    '| Id | Umbral | Escenario | Método |',
    '|---|---|---|---|',
    ...(rnf.length ? rnf : ['| — | — | — | — |']),
    '',
  ].join('\n');
}

export function renderDocs(spec: Spec, tasksByCriterion: Map<string, string[]> = new Map()): Doc[] {
  const docs: Doc[] = [];
  const index = [
    header(spec, spec.sistema.nombre),
    `**Objetivo:** ${spec.sistema.objetivo}`,
    '',
    '## Alcance',
    list(spec.sistema.alcance),
    '',
    '## Fuera de alcance',
    list(spec.sistema.fuera_de_alcance),
    '',
    '## Actores',
    list(spec.actores.map((a) => `**${a.id}** ${a.nombre} (${a.tipo}): ${a.descripcion}`)),
    '',
    '## Requisitos',
    list(spec.requisitos.map((r) => `**${r.id}** [${r.prioridad}] ${r.texto}`)),
    '',
    '## Casos de uso',
    list(spec.casos_uso.map((u) => `[${u.id} · ${u.nombre}](casos-de-uso/${u.id}.md)`)),
    '',
    '## Decisiones',
    list(spec.decisiones.map((d) => `**${d.id}** (${d.estado}) ${d.texto} — ${d.motivo}`)),
    '',
    '## Preguntas pendientes',
    list(spec.preguntas.map((q) => `**${q.id}** ${q.texto} (bloquea: ${q.bloquea.join(', ') || 'nada'}; responsable: ${q.responsable})`), 'Ninguna.'),
    '',
    '## Documentos',
    '- [Reglas](reglas.md) · [Modelo de datos](modelo-de-datos.md) · [Glosario](glosario.md) · [Trazabilidad](trazabilidad.md) · [Plan de pruebas](plan-de-pruebas.md)',
    '',
  ].join('\n');
  docs.push({ path: 'README.md', sources: ['sistema', 'actores', 'requisitos', 'decisiones', 'preguntas'], content: index });
  for (const uc of spec.casos_uso) {
    docs.push({ path: `casos-de-uso/${uc.id}.md`, sources: [uc.id], content: useCaseDoc(spec, uc) });
    docs.push({ path: `aceptacion/${uc.id}.feature`, sources: [uc.id], content: featureDoc(spec, uc) });
  }
  docs.push({
    path: 'reglas.md',
    sources: ['reglas'],
    content: [header(spec, 'Reglas de negocio'), list(spec.reglas.map((r) => `**${r.id}** ${r.texto} _(ref: ${r.referencias.join(', ') || '—'})_`)), ''].join('\n'),
  });
  docs.push({ path: 'modelo-de-datos.md', sources: ['entidades'], content: dataModelDoc(spec) });
  docs.push({
    path: 'glosario.md',
    sources: ['terminos'],
    content: [header(spec, 'Glosario'), '| Término | Definición |', '|---|---|', ...spec.terminos.map((t) => `| ${md(t.termino)} | ${md(t.definicion)} |`), ''].join('\n'),
  });
  docs.push({ path: 'trazabilidad.md', sources: ['requisitos', 'criterios'], content: traceDoc(spec, tasksByCriterion) });
  docs.push({ path: 'plan-de-pruebas.md', sources: ['criterios', 'rnf'], content: testPlanDoc(spec) });
  return docs;
}

type ManifestEntry = { sources: string[]; template_version: string; source_hash: string; rendered_hash: string };
type Manifest = { version: 1; files: Record<string, ManifestEntry> };

export type WriteReport = { written: string[]; unchanged: string[]; conflicts: string[] };

/**
 * Writes docs idempotently. A file edited by hand (its hash differs from what Forja
 * last wrote) is never overwritten: the new version goes to `<file>.nuevo`.
 */
export function writeDocs(dir: string, spec: Spec, docs: Doc[]): WriteReport {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'manifiesto.json');
  const manifest: Manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest) : { version: 1, files: {} };
  const report: WriteReport = { written: [], unchanged: [], conflicts: [] };
  const sourceHash = (sources: string[]) =>
    hashJson(sources.map((s) => (spec as unknown as Record<string, unknown>)[s] ?? spec.casos_uso.find((u) => u.id === s) ?? s));
  for (const doc of docs) {
    const path = join(dir, doc.path);
    const rendered = hashBytes(doc.content);
    const entry: ManifestEntry = { sources: doc.sources, template_version: TEMPLATE_VERSION, source_hash: sourceHash(doc.sources), rendered_hash: rendered };
    const previous = manifest.files[doc.path];
    if (existsSync(path)) {
      const current = hashBytes(readFileSync(path));
      if (current === rendered) {
        report.unchanged.push(doc.path);
        manifest.files[doc.path] = entry;
        continue;
      }
      if (!previous || current !== previous.rendered_hash) {
        writeFileSync(`${path}.nuevo`, doc.content);
        report.conflicts.push(doc.path);
        continue;
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.content);
    manifest.files[doc.path] = entry;
    report.written.push(doc.path);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return report;
}
