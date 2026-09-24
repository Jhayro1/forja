import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDocs, writeDocs } from '../../src/spec/docs.js';
import { SpecBody, validateSpec } from '../../src/spec/spec.js';
import { llmSchema } from '../../src/planner/session.js';
import { sampleSpec } from './fixture.js';

describe('validación de la spec', () => {
  it('una spec coherente no tiene errores', () => {
    expect(validateSpec(sampleSpec()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('detecta referencias rotas, ids duplicados y huecos', () => {
    const s = sampleSpec();
    s.casos_uso[0]!.actor_id = 'A-009';
    s.casos_uso[0]!.excepciones[0]!.desde_paso = 'P7';
    s.casos_uso[1]!.excepciones_no_aplican = null;
    s.criterios[1]!.id = 'CA-UC-001-02';
    s.reglas.push({ id: 'REQ-001', texto: 'dup', referencias: [] });
    const messages = validateSpec(s).filter((i) => i.severity === 'error').map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'actor A-009 no existe',
        'la excepción parte del paso P7, que no existe',
        'no tiene excepciones ni justifica por qué no aplican',
        'el id debe empezar con CA-UC-002-',
        expect.stringMatching(/id duplicado REQ-001/),
      ]),
    );
  });

  it('un requisito entregable sin criterio es un error', () => {
    const s = sampleSpec();
    s.criterios = s.criterios.filter((c) => c.caso_uso_id !== 'UC-002');
    const messages = validateSpec(s).map((i) => i.message);
    expect(messages).toContain('requisito entregable sin criterio de aceptación que lo verifique');
    expect(messages).toContain('no tiene criterios de aceptación');
  });

  it('el esquema para el modelo es estricto en todos los niveles', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.properties) {
        expect(n.additionalProperties).toBe(false);
        expect(new Set(n.required as string[])).toEqual(new Set(Object.keys(n.properties as object)));
      }
      Object.values(n).forEach(walk);
    };
    walk(llmSchema(SpecBody));
  });
});

describe('documentos generados', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('genera índice, casos, features en español, trazabilidad y plan de pruebas', () => {
    dir = mkdtempSync(join(tmpdir(), 'forja-docs-'));
    const spec = sampleSpec();
    const report = writeDocs(dir, spec, renderDocs(spec, new Map([['CA-UC-001-01', ['T-003']]])));
    expect(report.written).toContain('casos-de-uso/UC-001.md');
    const feature = readFileSync(join(dir, 'aceptacion/UC-001.feature'), 'utf8');
    expect(feature).toContain('# language: es');
    expect(feature).toContain('Escenario: CA-UC-001-01');
    expect(feature).toContain('Dado un cliente con saldo 0');
    expect(readFileSync(join(dir, 'casos-de-uso/UC-001.md'), 'utf8')).toContain('**EX1** (desde P1) · monto no positivo → se rechaza con 422');
    expect(readFileSync(join(dir, 'trazabilidad.md'), 'utf8')).toContain('| REQ-001 | Registrar un fiado | UC-001 | CA-UC-001-01 | T-003 |');
    expect(readFileSync(join(dir, 'modelo-de-datos.md'), 'utf8')).toContain('erDiagram');
  });

  it('regenerar sin cambios no toca nada y lo editado a mano no se pisa', () => {
    dir = mkdtempSync(join(tmpdir(), 'forja-docs-'));
    const spec = sampleSpec();
    writeDocs(dir, spec, renderDocs(spec));
    expect(writeDocs(dir, spec, renderDocs(spec)).written).toEqual([]);
    writeFileSync(join(dir, 'reglas.md'), '# mis notas\n');
    spec.reglas[0]!.texto = 'texto nuevo';
    const report = writeDocs(dir, spec, renderDocs(spec));
    expect(report.conflicts).toEqual(['reglas.md']);
    expect(readFileSync(join(dir, 'reglas.md'), 'utf8')).toBe('# mis notas\n');
    expect(existsSync(join(dir, 'reglas.md.nuevo'))).toBe(true);
  });
});
