# Formato · `spec.json`

Salida estructurada del planeador. **Sólo decisiones**, sin prosa. Se valida con zod
(`packages/generador/esquemas/spec.ts`) y de ahí se genera el JSON Schema que se pasa al
CLI (`--json-schema` / `--output-schema`).

```jsonc
{
  "version": 1,
  "sistema": { "nombre": "Mi Bodega", "objetivo": "Registrar fiados por voz", "fuera_de_alcance": ["Facturación electrónica"] },
  "actores": [
    { "id": "A-1", "nombre": "Bodeguero", "tipo": "humano" },
    { "id": "A-2", "nombre": "Recordatorio diario", "tipo": "sistema" }
  ],
  "terminos": [ { "termino": "fiado", "definicion": "Venta a crédito informal a un cliente conocido" } ],
  "entidades": [
    { "id": "E-1", "nombre": "Cliente", "campos": [
      { "nombre": "id", "tipo": "uuid", "requerido": true },
      { "nombre": "nombre", "tipo": "texto", "requerido": true, "reglas": ["R-02"] }
    ]}
  ],
  "reglas": [
    { "id": "R-01", "texto": "Un fiado no puede superar el límite de crédito del cliente", "tipo": "validacion" }
  ],
  "casos_uso": [
    {
      "id": "UC-001", "nombre": "Registrar fiado por voz", "actor": "A-1", "prioridad": "alta",
      "precondiciones": ["Cliente registrado"],
      "pasos": ["El bodeguero dicta el fiado", "El sistema transcribe e identifica cliente y monto", "El sistema muestra el resumen", "El bodeguero confirma", "El sistema guarda el fiado"],
      "alternos": [ { "id": "A1", "desde_paso": 2, "condicion": "Cliente no encontrado", "pasos": ["El sistema ofrece crearlo"] } ],
      "excepciones": [ { "id": "E1", "desde_paso": 5, "condicion": "Supera el límite (R-01)", "resultado": "Se rechaza con el saldo disponible" } ],
      "reglas": ["R-01"], "entidades": ["E-1", "E-2"],
      "criterios": [
        { "id": "CA-1", "dado": "un cliente con límite 100 y deuda 90", "cuando": "dicto un fiado de 20", "entonces": "se rechaza indicando saldo disponible 10" }
      ]
    }
  ],
  "rnf": [ { "id": "RNF-1", "texto": "Transcripción en < 3 s", "medible": { "metrica": "p95_ms", "umbral": 3000 } } ],
  "integraciones": [ { "id": "I-1", "nombre": "Correo de resumen", "conexion": "smtp-empresa", "permisos": ["correo:enviar"] } ],
  "decisiones": [ { "id": "D-01", "texto": "Montos en céntimos enteros", "sobre": ["E-2"] } ],
  "preguntas_abiertas": []
}
```

## Reglas de completitud (además de los tipos)

1. Cada `casos_uso[]` tiene ≥ 1 `excepciones` y ≥ 1 `criterios`.
2. Cada criterio tiene `dado`, `cuando` y `entonces` no vacíos.
3. Cada `reglas[].id` está referenciado por al menos un caso de uso o una entidad.
4. Cada id de `entidades` usado en un caso de uso existe.
5. Cada `integraciones[].conexion` tiene un nombre (no hace falta que exista aún en la bóveda).
6. Los ids son únicos y con el prefijo correcto (`UC-`, `R-`, `E-`, `CA-`, `RNF-`, `I-`, `D-`).
7. `preguntas_abiertas` vacío para aprobar (o cada una marcada `decidir_despues: true`).
