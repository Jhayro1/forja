import type { Spec } from '../../src/spec/spec.js';

/** Minimal valid spec used across tests (bodega / fiados). */
export function sampleSpec(): Spec {
  return {
    schema_version: 2,
    project_id: 'prj_X',
    change_id: 'cam_X',
    revision: 1,
    sistema: { nombre: 'Fiados', objetivo: 'Registrar fiados y saldos', alcance: ['registrar fiados', 'consultar saldo'], fuera_de_alcance: ['facturación'] },
    actores: [{ id: 'A-001', nombre: 'Dueño', tipo: 'humano', descripcion: 'Usa la app' }],
    terminos: [{ termino: 'fiado', definicion: 'venta a crédito' }],
    requisitos: [
      { id: 'REQ-001', texto: 'Registrar un fiado', prioridad: 'alta', origen: 'DEC-1' },
      { id: 'REQ-002', texto: 'Consultar saldo', prioridad: 'media', origen: 'DEC-2' },
    ],
    entidades: [
      {
        id: 'E-001',
        nombre: 'Cliente',
        campos: [
          { nombre: 'nombre', tipo: 'texto', requerido: true, restriccion: 'no vacío' },
          { nombre: 'telefono', tipo: 'texto', requerido: false, restriccion: null },
        ],
        invariantes: ['saldo = fiados − abonos'],
      },
    ],
    reglas: [{ id: 'R-001', texto: 'Un abono no puede superar la deuda', referencias: ['REQ-001'] }],
    casos_uso: [
      {
        id: 'UC-001',
        nombre: 'Registrar fiado',
        actor_id: 'A-001',
        objetivo: 'Anotar lo que se fía',
        precondiciones: ['cliente existe'],
        postcondiciones: ['saldo actualizado'],
        pasos: [
          { id: 'P1', texto: 'El dueño indica cliente y monto' },
          { id: 'P2', texto: 'El sistema guarda el fiado' },
        ],
        alternos: [{ id: 'AL1', desde_paso: 'P1', condicion: 'sin fecha', pasos: ['se usa la fecha de hoy'], retorno: 'P2' }],
        excepciones: [{ id: 'EX1', desde_paso: 'P1', condicion: 'monto no positivo', resultado: 'se rechaza con 422' }],
        excepciones_no_aplican: null,
        reglas: ['R-001'],
        entidades: ['E-001'],
        requisitos: ['REQ-001'],
      },
      {
        id: 'UC-002',
        nombre: 'Consultar saldo',
        actor_id: 'A-001',
        objetivo: 'Saber cuánto debe',
        precondiciones: [],
        postcondiciones: [],
        pasos: [{ id: 'P1', texto: 'El sistema devuelve el saldo' }],
        alternos: [],
        excepciones: [],
        excepciones_no_aplican: 'Sólo lectura: un cliente inexistente es 404 genérico de la API',
        reglas: [],
        entidades: ['E-001'],
        requisitos: ['REQ-002'],
      },
    ],
    criterios: [
      { id: 'CA-UC-001-01', caso_uso_id: 'UC-001', requisitos: ['REQ-001'], dado: 'un cliente con saldo 0', cuando: 'registro un fiado de 10', entonces: 'su saldo es 10', tipo_evidencia: 'automatica' },
      { id: 'CA-UC-002-01', caso_uso_id: 'UC-002', requisitos: ['REQ-002'], dado: 'fiados de 10 y 15 y un abono de 20', cuando: 'consulto el saldo', entonces: 'es 5', tipo_evidencia: 'automatica' },
    ],
    contratos: [{ id: 'CT-001', tipo: 'endpoint', descripcion: 'POST /clientes/:id/fiados', detalle: '{monto, fecha?, nota?} → 201' }],
    rnf: [],
    integraciones: [],
    decisiones: [{ id: 'DEC-1', texto: 'Montos en soles con 2 decimales', motivo: 'simple', estado: 'aprobada' }],
    preguntas: [],
  };
}
