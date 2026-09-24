# 05 · Generación barata de documentos y tareas

## La regla

> El modelo caro **decide**. El código **escribe**.

Un modelo de primer nivel redactando 30 archivos Markdown gasta la mayor parte de sus
tokens de salida en formato, encabezados y frases repetidas. Todo eso lo puede hacer
una plantilla gratis.

```
Tú ⇄ planeador ──► spec.json (compacto) ──► validación (zod) ──► plantillas ──► docs + .feature + tareas
                   miles de tokens          0 tokens               0 tokens
                                               │
                                     ¿falta algo? ──► pedir SÓLO ese hueco al planeador
```

## Qué produce el LLM y qué produce el código

| Artefacto | Quién |
|-----------|-------|
| Actores, casos de uso, pasos, alternos, excepciones, reglas, entidades, criterios | **Planeador** (dentro de `spec.json`) |
| `casos-de-uso/UC-*.md` con tablas, numeración y enlaces cruzados | Plantilla |
| `aceptacion/UC-*.feature` (Gherkin) | Plantilla, desde los criterios |
| Tabla de errores y excepciones | Código: cada `excepcion` del JSON es una fila |
| Matriz de trazabilidad (UC ↔ regla ↔ criterio ↔ test ↔ tarea) | Código |
| Glosario | Código, desde `terminos` |
| Modelo de datos (tabla y diagrama Mermaid) | Plantilla, desde `entidades` |
| Plan de pruebas | Código: un test pendiente por criterio y por excepción |
| Esqueletos de test (`it.todo`, `t.Skip`) | Plantilla según el stack del perfil |
| Borrador de tareas | Código, por reglas (ver abajo) |
| Ajuste de tareas: partir, unir, dependencias finas | **Planeador**, una sola llamada con el borrador |
| Prosa de introducción o de visión | **Planeador**, sólo si la pides (`--con-prosa`) |

## Validación y huecos

`spec.json` se valida con el esquema zod de [formatos/spec-json.md](formatos/spec-json.md).
Además de los tipos, hay **reglas de completitud**:

- cada caso de uso tiene ≥ 1 excepción y ≥ 1 criterio;
- cada criterio tiene `dado`, `cuando` y `entonces`;
- cada regla la referencia al menos un caso de uso;
- cada entidad usada en un caso de uso está definida;
- cada integración externa declara la conexión que necesita.

Si algo falla, el generador envía al planeador **sólo la lista de huecos** con el
fragmento pertinente, no todo el spec, y fusiona la respuesta.

## Reglas para el borrador de tareas (sin LLM)

| Si el spec tiene… | Se generan tareas… |
|-------------------|--------------------|
| una entidad | `esquema` (tipo + validación) y `persistencia` (migración/repositorio) — **ola 0 de contratos** |
| un caso de uso con actor humano | `servicio`, `interfaz` (endpoint o pantalla según el stack) y `aceptacion` (tests desde `.feature`) |
| un caso de uso de sistema (job, webhook) | `servicio`, `disparador` y `aceptacion` |
| una integración externa | `adaptador` (con mock) y `prueba-integracion` (marcada `requiere_conexion`) |
| un requisito no funcional medible | `verificacion-rnf` (p. ej. test de rendimiento) |

Luego el planeador ajusta el borrador en una sola llamada. Recibe **el borrador**, no
el spec completo, más un resumen de los casos de uso.

## Idempotencia

Cada archivo generado lleva en su cabecera el hash del fragmento de `spec.json` que lo
originó. Al regenerar:
- si el hash no cambió, no se toca;
- si cambió y **no** fue editado a mano, se regenera;
- si cambió y **sí** fue editado a mano (el hash del contenido no coincide), se genera
  `archivo.nuevo.md` y se avisa para que decidas.
