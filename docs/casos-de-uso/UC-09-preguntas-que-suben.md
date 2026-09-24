# UC-09 · Responder preguntas que suben

**Actores:** Trabajador, Planeador, Usuario · **Reglas:** R-06

**Precondiciones:** tarea en ejecución.

## Flujo principal
1. El trabajador declara una duda con el formato acordado en su prompt (herramienta `preguntar` o bloque marcado).
2. Forja busca la respuesta en la memoria (decisiones, reglas, spec). Si hay una coincidencia clara, responde al trabajador citando el nodo.
3. Si no, pregunta al planeador con la duda, la tarea y el contexto relevante.
4. Si el planeador responde con confianza, la respuesta se guarda como `D-*` (repo + memoria) y vuelve al trabajador.
5. El trabajador continúa.

## Flujos alternos
- **A1 · El planeador no puede decidir** (depende del negocio): la pregunta llega al usuario en «Pendiente de ti» con opciones y recomendación; la tarea queda `esperando_respuesta` y el resto sigue.
- **A2 · La misma pregunta llega desde otra tarea:** se responde desde la decisión ya guardada, sin volver a preguntar.
- **A3 · La respuesta cambia la especificación:** se aplica UC-13.

## Excepciones
- **E1 · El trabajador no puede esperar (el CLI no admite pausa):** se hace checkpoint, se termina el proceso y, con la respuesta, se reanuda la sesión o se relanza con el diff (no cuenta como fallo).
- **E2 · El usuario no responde en N horas:** recordatorio; la tarea sigue esperando (no se inventa una respuesta).

## Criterios de aceptación
- **CA-1** Dada una decisión D-07 sobre el redondeo, cuando otro trabajador pregunta por el redondeo, entonces recibe D-07 sin que se llame al planeador.
- **CA-2** Dada una pregunta que llegó al usuario, cuando la responde, entonces existe `.forja/decisiones/D-xx.md` y la tarea continúa.
