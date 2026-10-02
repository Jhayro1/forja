import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRequirementsWorkbook } from '../../src/export/requirements.js';
import { buildXlsx } from '../../src/export/xlsx.js';
import { createChange } from '../../src/planner/session.js';
import { startOrResumeRun } from '../../src/run/orchestrator.js';
import { saveSpec } from '../../src/spec/generate.js';
import type { SpecBody } from '../../src/spec/spec.js';
import { EpicService } from '../../src/work/epics.js';
import { testEngine } from '../helpers/engine.js';
import { seedApprovedPlan, TASKS } from '../run/fixture.js';
import { sampleSpec } from '../spec/fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** Reads a ZIP (central directory + deflate): every part of the .xlsx as text. */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    files.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

/** Text of every row of a sheet, resolving shared strings (formulas as «=…»). */
function rows(files: Map<string, string>, sheetName: string): string[][] {
  const sst = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si><t xml:space="preserve">([\s\S]*?)<\/t><\/si>/g)].map((m) =>
    m[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  );
  const names = [...files.get('xl/workbook.xml')!.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  const xml = files.get(`xl/worksheets/sheet${names.indexOf(sheetName) + 1}.xml`)!;
  const col = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [...xml.matchAll(/<row r="\d+"[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
    const out: string[] = [];
    for (const c of r[1]!.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?: t="(\w+)")?>(?:<f>([\s\S]*?)<\/f>)?(?:<v>([\s\S]*?)<\/v>)?<\/c>/g)) {
      out[col(c[1]!)] = c[3] ? `=${c[3].replace(/&quot;/g, '"').replace(/&amp;/g, '&')}` : c[2] === 's' ? sst[Number(c[4])]! : (c[4] ?? '');
    }
    return Array.from(out, (v) => v ?? '');
  });
}

describe('escritor de .xlsx', () => {
  it('arma un ZIP válido con hojas, textos compartidos, tablas, validaciones y fórmulas', () => {
    const data = buildXlsx([
      {
        name: 'Hoja/con:raros*',
        rows: [
          [
            { v: 'A', s: 'header' },
            { v: 'B', s: 'header' },
          ],
          ['x < y & "z"\u0001', 2],
          ['A', { f: 'B2*2', s: 'number' }],
        ],
        tables: [{ name: 'tb_x', ref: 'A1:B3', columns: ['A', 'B'] }],
        validations: [{ ref: 'A2:A3', list: '"uno,dos"' }],
        freezeRows: 1,
      },
    ]);
    const files = unzip(data);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/tables/table1.xml', 'xl/worksheets/sheet1.xml']));
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Hoja con raros " sheetId="1"');
    expect(files.get('xl/sharedStrings.xml')).toContain('x &lt; y &amp; &quot;z&quot;</t>');
    expect(files.get('xl/sharedStrings.xml')).not.toContain('\u0001');
    expect(files.get('xl/tables/table1.xml')).toContain('ref="A1:B3"');
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('<f>B2*2</f>');
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('state="frozen"');
    expect(rows(files, 'Hoja con raros ')[1]).toEqual(['x < y & "z"', '2']);
  });
});

describe('libro de requerimientos', () => {
  it('lleva el sprint al mapa, sus casos al DER con estado y a las HU finales con horas y tareas', async () => {
    const t = testEngine(() => ({ pasos: [] }));
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const epics = new EpicService(t.engine);
    const epic = epics.create({ title: 'Crédito a clientes', goal: 'Vender al fiado sin perder la cuenta' });
    epics.assign(changeId, { epic_id: epic.epic_id, priority: 1, target_date: '2026-10-30' });
    // A second revision changes UC-002 and adds UC-003: «Cambiado» and «nueva».
    const { schema_version: _v, project_id: _p, change_id: _c, revision: _r, ...body } = sampleSpec();
    const uc3 = { ...body.casos_uso[1]!, id: 'UC-003', nombre: 'Ver deudores' };
    const next: SpecBody = {
      ...body,
      casos_uso: [body.casos_uso[0]!, { ...body.casos_uso[1]!, nombre: 'Consultar saldo y abonos' }, uc3],
      criterios: [...body.criterios, { ...body.criterios[1]!, id: 'CA-UC-003-01', caso_uso_id: 'UC-003' }],
    };
    saveSpec(t.engine, { changeId, repoPath: repo, projectId: t.engine.config.project_id, body: next });
    createChange(t.engine, 'otro', 'Cotizaciones', 'idea');

    const book = buildRequirementsWorkbook(t.engine, { iniciativa: 'ini009', today: '2026-10-02' });
    expect(book.file).toBe('INI009_prueba_Reqs_2026-10-02.xlsx');
    expect(book).toMatchObject({ sprints: 2, stories: 3 });
    const files = unzip(book.data);

    const mapa = rows(files, '1. Mapa_Procesos');
    expect(mapa[0]).toEqual(['ID', 'Macroproceso', 'Proceso', 'Código Subproceso', 'Subproceso', 'Objetivo', 'Descripción', 'TO BE', 'Alcance']);
    expect(mapa[1]!.slice(0, 5)).toEqual(['1', 'prueba', 'Crédito a clientes', 'P01', expect.any(String)]);
    expect(mapa[1]![7]).toMatch(/En una versión inicial, el sistema debe priorizar/);
    expect(mapa[1]![8]).toBe('Alcance 1');
    // The sprint still in conversation: Alcance 2, one placeholder row in the DER.
    expect(mapa[2]!.slice(3)).toEqual(['P02', 'Cotizaciones', expect.any(String), expect.any(String), expect.stringMatching(/podría/), 'Alcance 2']);

    // Rows with an epic code: the stories (the placeholder of the second sprint has none).
    const der = rows(files, '2. DER').filter((r) => /_E\d\d$/.test(r[6] ?? ''));
    expect(der.map((r) => [r[9], r[12]])).toEqual([
      ['INI009_P01_E01_HU01', 'Aprobado'],
      ['INI009_P01_E01_HU02', 'Cambiado'],
      ['INI009_P01_E01_HU03', 'Aprobado'],
    ]);
    expect(der[0]![8]).toMatch(/^Objetivo funcional: .*\nAlcance incluido: .*\nReglas principales: .*\nEntidades requeridas: Cliente\.\nDependencias: /s);
    expect(der[0]![11]).toMatch(/^Como dueño, quiero .+, para .+\.\nDetalle funcional: .*\nReglas principales: .*\nCriterios de aceptación: dado .*\nExcepciones\/consideraciones: /s);
    expect(rows(files, '2. DER').at(-1)!.slice(4, 6)).toEqual(['P02', 'Cotizaciones']);

    const finales = rows(files, '3. Épicas y HU finales').slice(2);
    expect(finales.map((r) => [r[4], r[7]])).toEqual([
      ['INI009_P01_E01_HU01', 'Alcance 1'],
      ['INI009_P01_E01_HU02', 'Alcance 1'],
      ['INI009_P01_E01_HU03', 'nueva'],
    ]);
    expect(finales[0]!.slice(12, 16)).toEqual(['=I3+J3+K3+L3', '0.15', '=M3*N3', '=M3+O3']);
    expect(finales[0]![16]).toMatch(/^P01 · /);
    expect(finales[0]![21]).toBe('2026-10-30');

    const tareas = rows(files, '4. Tareas').slice(1);
    expect(tareas).toHaveLength(TASKS.length);
    expect(tareas.every((r) => r[0] === 'P01')).toBe(true);
    expect(tareas.some((r) => r[2] === 'INI009_P01_E01_HU01')).toBe(true);

    expect(
      rows(files, 'Lista')
        .slice(3)
        .map((r) => r[1]),
    ).toEqual(['Aprobado', 'Fusionado', 'Dividido', 'Cambiado', 'Postergado', 'Descartado']);
    expect(files.get('xl/worksheets/sheet4.xml')).toContain('<formula1>Lista!$B$9:$B$14</formula1>');
    expect(rows(files, 'Consulta_Subproceso').at(-1)![0]).toMatch(/^=IF\(\$B\$3="",.*INDEX\('1\. Mapa_Procesos'!\$A\$2:\$A\$3,MATCH/);
    expect(rows(files, '0. Instrucciones').flat().join('\n')).toMatch(/fiado: venta a crédito/);
  });
});
