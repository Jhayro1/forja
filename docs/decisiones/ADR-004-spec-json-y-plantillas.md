# ADR-004 · El planeador devuelve JSON y las plantillas escriben los documentos

**Estado:** aceptada · 2026-09-24

## Contexto

Pedir a un modelo caro que redacte decenas de archivos Markdown gasta la mayor parte de
su salida en formato y repetición. Además, los documentos quedan inconsistentes entre sí.

## Decisión

El planeador produce **`spec.json`** validado con un esquema (salida estructurada:
`--json-schema` en Claude, `--output-schema` en Codex). Todos los documentos, `.feature`,
matrices y borradores de tareas se generan con plantillas y reglas en código.

## Consecuencias

- Los tokens de salida del planeador se reducen a las decisiones.
- Los documentos son consistentes y trazables (IDs estables UC-/R-/CA-/T-).
- Regenerar es gratis e idempotente (hash por fragmento).
- La prosa narrativa sólo se pide explícitamente (`--con-prosa`).
- El esquema de `spec.json` pasa a ser un contrato central: cambios versionados y con migración.
