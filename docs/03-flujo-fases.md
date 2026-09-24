# 03 · Flujo por fases

```
 (sólo si ya hay código)
 ┌──────────┐   ┌──────────┐   ┌────────────┐   ┌─────────┐ ▐ ┌──────────┐   ┌───────────┐   ┌──────┐
 │0 Analizar│ → │1 Descubrir│ → │2 Especificar│ → │3 Dividir│ ▐→│4 Ejecutar│ → │5 Verificar│ → │6 Unir│
 └──────────┘   └──────────┘   └────────────┘   └─────────┘ ▐ └──────────┘   └───────────┘   └──────┘
  barato+código   planeador+tú    planeador→JSON    planeador   ▐   baratos        tests+revisor   código
                                  plantillas→docs   +código     ▐   en paralelo    escalera
                                                              PUERTA
                                                          (apruebas spec,
                                                           tareas y costo)
```

Cada fase **lee archivos y escribe archivos**. Se puede repetir cualquier fase sin
repetir las anteriores, y cada una deja eventos en el estado. Si se interrumpe,
continúa donde quedó (ver [07](07-persistencia-y-recuperacion.md)).

---

## Fase 0 · Analizar (sólo para código existente)

| | |
|--|--|
| **Entrada** | El repositorio |
| **Qué hace** | 1. **tree-sitter** extrae archivos, símbolos, imports y llamadas: grafo de código, 0 tokens. 2. Detecta el **perfil del proyecto** (package.json, go.mod, Makefile, CI) y prueba los comandos de build y test. 3. Un modelo **barato** resume cada módulo en ≤ 5 líneas, sólo los módulos que cambiaron desde el último análisis (hash por archivo). 4. El **planeador** lee los resúmenes (no el código) y escribe la arquitectura, las convenciones y la deuda técnica. |
| **Salida** | `memoria.db` (grafo de código), `.forja/docs/arquitectura-actual.md`, `.forja/docs/convenciones.md`, perfil en `forja.yaml` |
| **Costo típico** | Bajo: los resúmenes son baratos y el planeador sólo lee resúmenes |

## Fase 1 · Descubrir

| | |
|--|--|
| **Entrada** | Tu idea, o la mejora que quieres sobre el código analizado |
| **Qué hace** | El **planeador** te entrevista con una lista de verificación: actores, objetivos, alcance y fuera de alcance, reglas de negocio, datos, integraciones externas, requisitos no funcionales, restricciones y criterios de éxito. Pregunta en tandas cortas y propone opciones con recomendación. Mantiene al día una lista de **preguntas abiertas**. |
| **Termina cuando** | La lista de preguntas abiertas está vacía (o lo que queda está marcado «decidir después») y apruebas el resumen |
| **Salida** | `.forja/descubrimiento.md` (resumen aprobado) y la transcripción en `sesiones/` |
| **Ahorro** | Se usa la sesión persistente del CLI (reanudar sesión) para no reenviar el historial, y el resumen reemplaza a la transcripción en las fases siguientes |

## Fase 2 · Especificar

| | |
|--|--|
| **Entrada** | `descubrimiento.md` |
| **Qué hace** | El **planeador** devuelve `spec.json`: actores, casos de uso (pasos, alternos, excepciones), reglas, entidades, criterios Given/When/Then, requisitos no funcionales e integraciones. El **generador** lo valida con un esquema: si falta algo (un caso de uso sin excepciones, un criterio sin «Then»), pide **sólo ese hueco**. Luego renderiza las plantillas. |
| **Salida** | `.forja/spec.json`, `.forja/docs/**` (casos de uso, reglas, modelo de datos, plan de pruebas, glosario), `.forja/aceptacion/*.feature`, nodos de especificación en la memoria |
| **Costo** | Sólo el JSON: miles de tokens, no decenas de miles. Ver [05](05-generacion-barata.md) |

## Fase 3 · Dividir

| | |
|--|--|
| **Entrada** | `spec.json` y perfil del proyecto |
| **Qué hace** | 1. **Código**: genera tareas base por regla (por cada entidad: esquema y migración; por cada caso de uso: servicio, endpoint o UI y tests de aceptación). 2. **Planeador** (una llamada): ajusta el borrador (parte tareas grandes, une las triviales, fija dependencias y archivos) y marca la **ola 0 de contratos**. 3. **Código**: valida que el grafo no tenga ciclos y que dos tareas de la misma ola no compartan archivos, calcula olas, asigna nivel y presupuesto, y **estima el costo total**. |
| **Salida** | `.forja/tareas/T-*.yaml`, `.forja/plan.md` (olas, grafo y estimación) |

### 🚧 Puerta de ejecución

No se ejecuta nada hasta que apruebas en la UI o con `forja aprobar`. Se muestra:
- los casos de uso y criterios (lo que se va a construir),
- las tareas por ola y el grafo,
- el costo estimado por nivel y el uso estimado de cada suscripción,
- las conexiones externas que alguna tarea pide (ver [09](09-boveda-secretos-y-conexiones.md)).

## Fase 4 · Ejecutar

| | |
|--|--|
| **Qué hace** | El **orquestador** toma las tareas listas (dependencias terminadas) hasta `paralelo_max`. Para cada una: crea el worktree y la rama `forja/T-014`, arma el **paquete de contexto** desde la memoria, prepara el entorno (secretos permitidos, MCP temporal), lanza el adaptador con el nivel asignado y transmite su salida a la UI y a los logs. |
| **Preguntas del trabajador** | Si el agente se traba, la pregunta **sube**: memoria → planeador → tú. La respuesta se guarda como decisión `D-*` y vuelve al agente. |
| **Límites** | Si el proveedor responde «límite de uso alcanzado», el orquestador pausa ese proveedor hasta la hora de reinicio y reparte las tareas pendientes al otro, si está permitido. |

## Fase 5 · Verificar

Ver [12](12-verificacion-y-calidad.md). Resumen: build, lint, tests de la tarea y
tests previos (0 tokens) → si todo pasa, un revisor barato revisa el diff contra
los criterios → aprobada. Si algo falla, se reintenta con el error como
contexto, y después se escala de nivel.

## Fase 6 · Unir

La **cola de merge** integra las ramas aprobadas en orden de dependencias sobre la rama
de integración `forja/integracion`, y corre la suite completa después de cada una. Un
conflicto trivial (imports, listas) se resuelve con código; uno real se asigna como
tarea de nivel medio. Al final hay un informe y la opción de abrir un PR a `main`
(**nunca** hace merge a `main` sin aprobación).

---

## Cambios de especificación a mitad de camino

1. Editas la especificación, o se lo pides al planeador.
2. Forja calcula la diferencia del `spec.json`.
3. La memoria encuentra las tareas afectadas: las que implementan un caso de uso, regla
   o entidad que cambió.
4. Esas tareas pasan a **invalidadas**. Si ya estaban unidas, se genera una tarea de
   corrección; el resto sigue su curso.
5. Nueva puerta de aprobación sólo para lo que cambió.
