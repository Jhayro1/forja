# 04 · Modelos y costos

## Niveles

Los nombres de los modelos **no están en el código**: se configuran en `forja.yaml`
(global o por proyecto), para que un modelo nuevo sea una línea de configuración.

| Nivel | Uso | Ejemplos (a confirmar con cada CLI) |
|------|-----|--------------------------------------|
| `planeador` | Descubrir, Especificar, Dividir, responder preguntas que suben, arreglar lo que falló dos veces | Claude: Opus, Fable · Codex: sol, Astra |
| `medio` | Tareas complejas, conflictos de merge, segundo intento | Claude: Sonnet · Codex: modelo medio |
| `barato` | La mayoría de las tareas de código, resúmenes de módulos, revisión de diffs | Claude: Haiku · Codex: modelo mini |

```yaml
niveles:
  planeador: [claude:opus, codex:sol]      # orden = preferencia
  medio:     [claude:sonnet]
  barato:    [claude:haiku, codex:mini]
```

El nombre exacto que acepta cada CLI (`--model`) se verifica en el spike (tarea T-001).

## Escalera

```
intento 1: barato  ──falla──►  intento 2: barato + error como contexto
                              ──falla──►  intento 3: medio
                                          ──falla──►  intento 4: planeador
                                                      ──falla──►  bloqueada: te pregunta
```

- Una tarea puede **empezar** en un nivel más alto si el planeador la marcó `complejidad: alta`.
- Cada intento guarda el diff y el error. El siguiente nivel **no empieza de cero**: recibe
  el diff anterior y la causa del fallo.
- Límites configurables: `max_intentos`, y si se permite llegar al nivel `planeador`.

## Qué mide Forja

Cada llamada genera un evento `uso` con: proveedor, modelo, nivel, fase, tarea,
tokens de entrada, de salida, de caché leída y de caché escrita, duración y
**costo equivalente**.

- **Con suscripción** no pagas por token, pero el **costo equivalente** (lo que costaría
  por API) sirve para comparar, y el **consumo del límite** es lo que realmente importa.
  Forja estima cuánto del límite de cada suscripción se lleva gastado en la ventana actual.
- Los precios por millón de tokens van en un archivo `precios.yaml` versionado que la
  comunidad actualiza. No se escriben en el código.
- Si algún día usas API key en lugar de suscripción, el mismo número pasa a ser el costo real.

## Presupuestos

| Nivel del presupuesto | Qué pasa al superarlo |
|-----------------------|------------------------|
| Por tarea (`presupuesto` en la tarea) | Se detiene el intento; cuenta como fallo y escala o se bloquea |
| Por fase | Pausa la fase y avisa |
| Por proyecto / por día | Pausa todo y avisa |

El orquestador **estima antes de ejecutar** (fase Dividir): tamaño del paquete de contexto,
× tokens de salida típicos por tipo de tarea, × probabilidad de escalar (aprendida de
ejecuciones anteriores, con un valor inicial conservador).

## Límites de suscripción

- El adaptador reconoce los mensajes o códigos de «límite alcanzado» de cada CLI.
- El proveedor pasa a estado `en_pausa_hasta=<hora>`; la UI muestra la cuenta regresiva.
- Las tareas pendientes se reasignan a otro proveedor del mismo nivel, si lo hay, o esperan.
- Nunca se reintenta en bucle contra un proveedor limitado.

## Técnicas de ahorro, en orden de impacto

1. **Especificación completa antes de codificar**: el trabajador barato no adivina.
2. **Paquete de contexto mínimo** ([06](06-memoria-grafo.md)): 5–15k tokens por tarea en lugar de explorar el repo.
3. **Tests como condición de término**: nada de «¿ya está?» en lenguaje natural.
4. **El LLM decide, las plantillas escriben** ([05](05-generacion-barata.md)).
5. **Prefijo estable**: convenciones, glosario y perfil siempre primero y en el mismo orden, para aprovechar la caché de prompts del proveedor.
6. **Reanudar sesiones** del planeador en lugar de reenviar el historial.
7. **Escalera**: el caro sólo interviene cuando el barato ya falló.
8. **Análisis incremental**: sólo se resume lo que cambió (hash por archivo).
9. **Herramientas restringidas por tarea**: el trabajador no tiene herramientas que no necesita, y así no gasta turnos explorando.
