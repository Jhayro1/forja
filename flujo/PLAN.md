# Sprints flexibles · plan de implementación

**Estado:** implementado en v0.5.0 · 2026-10-02 · decisiones en §7 · estado por entrega en §9

## 1. El problema

Hoy Forja sólo deja recorrer un sprint de principio a fin y en una sola dirección:

| Lo que el usuario quiere | Qué pasa hoy | Dónde está la traba |
|---|---|---|
| Tener varios sprints a la vez y cambiar entre ellos | Sólo existe «el sprint actual»: el último que no está entregado ni cancelado | `activeChange()` (`planner/session.ts`) se usa en el CLI, el panel, el tablero y las observaciones |
| Empezar otro sprint sin terminar el anterior | El chat lo impide («ya pasó la conversación… empieza uno nuevo cuando termine») y el plan de acción exige «termina o cancela primero» | `engine-backend.ts › send`, `work-backend.ts › actionPlan` |
| Cancelar o dejar en pausa un sprint | No hay forma de hacerlo: la fase `cancelado` existe, pero nada la usa | No hay comando ni ruta |
| Volver de «Especificar» a «Descubrir» para cambiar lo inicial | Imposible: el turno del planeador exige la fase `descubrir` | `runPlannerTurn` lanza «el descubrimiento ya se aprobó» |
| Cambiar casos de uso o respuestas ya dadas | Sólo por CLI (`forja especificar --cambio "…"`). En el panel sólo se responden preguntas abiertas, y al rehacer la especificación se rehace **entera** | No hay ruta `/v1/planeacion/cambio`; `generateSpec` no reutiliza las partes que no cambian |

Que el flujo tenga un orden está bien: **no se ejecuta nada sin una especificación y un plan
aprobados**. Lo que hay que corregir es que ese orden no permite volver atrás ni tener más de un
sprint vivo.

## 2. Principios

1. **Volver atrás nunca borra nada.** Al retroceder se conservan la conversación, la
   especificación y el plan anteriores, que sirven de base. Al avanzar otra vez sólo se rehace
   lo que cambió (ahorra tokens).
2. **Ningún retroceso se infiere.** Todo retroceso es un clic o comando explícito, con
   confirmación cuando invalida trabajo (por ejemplo, un plan aprobado).
3. **Varios sprints planeándose, uno ejecutándose por proyecto.** Planear es barato y no toca
   el repositorio. Ejecutar sí lo toca, y ya existe un candado de orquestador por proyecto.
4. **Eventos, como todo lo demás.** Cada retroceso, pausa o cancelación es un evento del
   registro: se ve en el historial y sobrevive a un reinicio.

## 3. Modelo de fases (máquina de estados)

```
descubrir ──aprobar──▶ especificar ──▶ dividir ──▶ aprobar ──▶ ejecutar ──▶ entregado
    ▲                      │              │           │           │
    └──── reabrir ─────────┴──────────────┴───────────┘           │ (detener primero)
                           ▲              │           │           │
                           └── editar ────┴───────────┘◀──────────┘
   cualquiera (menos entregado) ──cancelar──▶ cancelado ──reactivar──▶ descubrir
```

| Desde | Puede ir a | Condición | Qué se conserva |
|---|---|---|---|
| especificar · dividir · aprobar | **descubrir** (reabrir la conversación) | — | Conversación, decisiones, especificación y plan (como base) |
| dividir · aprobar | **especificar** (editar la especificación) | — | Especificación vigente como `spec_base`; el plan queda desactualizado |
| aprobar | **dividir** (volver a dividir) | — | El plan anterior se archiva |
| ejecutar | descubrir · especificar · dividir | Primero **detener** el run (candado del orquestador, igual que hoy con `--cambio`) | Las tareas ya integradas se heredan si su definición no cambia (V2-037, ya existe) |
| entregado | — | Es definitivo | Se ofrece «Nuevo sprint a partir de este» |
| cualquiera menos entregado | **cancelado** | Confirmación | Todo, sólo lectura |
| cancelado | **descubrir** (reactivar) | — | Todo |

Implementación:
- Un evento `cambio.fase_retrocedida` con `{ from, to, motivo }`. Se proyecta como el
  `changePhase` actual, pero con la tabla de transiciones válidas de arriba. Así el historial
  distingue «avanzó» de «volvió».
- Al reabrir el descubrimiento, `approved_revision` vuelve a `null`. El turno del planeador
  vuelve a aceptarse, y el prompt de `descubrir` recibe un aviso: «el usuario reabrió la
  conversación para cambiar X; la especificación anterior existe».

## 4. Varios sprints

- **Sprint seleccionado** en vez de `activeChange()`. Cada vista y cada comando trabaja sobre un
  `cambio` explícito:
  - API: parámetro `?cambio=<id>` en `/v1/planeacion`, `/v1/estado`, `/v1/trabajos`… Si
    falta, se usa el último elegido.
  - Panel: un selector «Sprint» en la cabecera del módulo Sprint, con fase, título y fecha, más
    el botón «Nuevo sprint» siempre visible (no sólo al entregar).
  - CLI: `forja cambios` (ya existe) lista los sprints, `forja usar <cambio>` selecciona uno y
    `--cambio <id>` vale en cualquier comando.
  - El último elegido se guarda en el checkout, en `<datos>/sprint-actual`, por proyecto. Es
    una preferencia de interfaz, no un hecho del dominio.
- **Trabajos (`especificar`, `dividir`…).** Siguen siendo uno a la vez por proyecto en la
  primera versión. El panel muestra de qué sprint es el trabajo en curso.
- **Ejecución.** Un solo run a la vez por proyecto, el candado que ya existe. Si otro sprint
  ya está ejecutando, «Aprobar y ejecutar» explica cuál y ofrece esperar.
- **Base de git.** Cuando otro sprint se entregó después de dividir, el `base_sha` del plan queda
  viejo. Al aprobar se compara con `HEAD`; si cambió, se pide volver a dividir, que es barato y
  sólo rehace el plan.
- **Observaciones → plan de acción.** Ya no exige terminar el sprint en curso: crea uno nuevo y
  lo selecciona.

## 5. Cambiar la especificación sin rehacerla entera

1. **Panel: «Pedir un cambio».** Un cuadro de texto en la especificación, más estos botones por
   caso de uso:
   - «Cambiar este caso»: abre el cuadro con «UC-003: …».
   - «Quitar este caso».
   - «Agregar un caso».

   Todo va por `requestSpecChange`, que ya existe pero sólo se usa desde el CLI. Ruta nueva:
   `POST /v1/planeacion/especificacion/cambios`.
2. **Respuestas editables.** Las preguntas ya respondidas se listan con su respuesta y un botón
   «Cambiar respuesta». El modelo de datos ya lo soporta: `spec_answers` hace *upsert* por
   pregunta.
3. **Regeneración parcial.** Es lo que más tokens ahorra y aprovecha la generación por partes de
   la v0.4.3:
   - Con `spec_base`, el índice de casos (parte 1) marca cada caso como `igual | cambia | nuevo
     | quitado`.
   - Los casos `igual` se copian de `spec_base` sin llamar al modelo.
   - Sólo se piden las partes con casos `cambia` o `nuevo`.
   - Un cambio en un solo UC cuesta la base más una parte, no la especificación completa.
4. **Edición manual de un caso.** Un formulario con nombre, pasos, excepciones y criterios.
   Genera una revisión nueva con autor `usuario`, validada con `validateSpec` antes de guardar.
   Sin modelo, sin tokens. *(Fase 2: útil pero no urgente.)*

## 6. Entregas

| # | Entrega | Contenido | Tamaño |
|---|---|---|---|
| **F1** | Volver atrás | Evento de retroceso y transiciones; reabrir el descubrimiento; volver de aprobar a especificar o dividir; cancelar y reactivar. Botones en el Stepper del panel («volver a esta fase»), comandos `forja volver <fase>` y `forja cancelar`. Pruebas de proyección y de *replay* | M |
| **F2** | Varios sprints | Sprint seleccionado (API `?cambio=`, CLI `usar`/`--cambio`, panel con selector); quitar las trabas de `send` y `actionPlan`; un run por proyecto con mensaje claro; aviso de `base_sha` viejo | M-L |
| **F3** | Cambios en la especificación desde el panel | «Pedir un cambio», cambiar o quitar o agregar un UC, cambiar respuestas; regeneración parcial (sólo las partes con casos que cambian) | M |
| **F4** | Edición manual | Formulario de un UC y sus criterios, validado, sin modelo | S-M |

Orden recomendado: **F1 → F3 → F2 → F4**.
- F1 y F3 resuelven lo que bloquea hoy: cambiar lo inicial y los UC.
- F2 toca más archivos (todo lo que hoy llama a `activeChange`) y conviene hacerlo con F1 ya
  estable.

Cada entrega lleva:
- pruebas (proyección, *replay* y ruta de API);
- una prueba de punta a punta con el planeador simulado;
- una versión (`v0.5.0` con F1+F3, `v0.6.0` con F2…).

## 7. Decisiones del usuario (2026-10-02)

1. **Un run por proyecto.** Se pueden tener y planear varios sprints a la vez.
2. **Volver atrás desde «ejecutar»:** sí. Se registra todo lo avanzado en el evento
   `cambio.movido` (revisiones, aprobación, run, tareas integradas). El run queda en pausa y lo
   integrado se hereda.
3. **Edición manual de UC:** sí, aunque se use en pocos casos.
4. **Al reabrir, el plan deja de estar aprobado**, pero se guarda todo.

## 8. Riesgos

- **`activeChange()` en muchos sitios.** Hay que cambiarlo en unos 15 lugares (CLI, panel,
  tablero, snapshot, observaciones). Se mitiga con una sola función
  `selectedChange(ctx, explicit?)` y pruebas que crean dos sprints.
- **Proyecciones existentes.** El evento nuevo no cambia los eventos viejos. Los registros
  actuales siguen reproduciéndose igual.
- **Panel con un trabajo en curso de otro sprint.** El JobCard tiene que decir de qué sprint es,
  para no confundir.

## 9. Estado (v0.5.0)

| # | Entrega | Estado | Dónde |
|---|---|---|---|
| F1 | Volver atrás, cancelar, reactivar | ✔ | `planner/phases.ts` (`MOVES`, `moveChange`), evento `cambio.movido`, CLI `volver`/`cancelar`/`reactivar`, panel «Volver o cancelar» |
| F2 | Varios sprints | ✔ | `planner/selection.ts` (`selectedChange`, `selectChange`, `findChange`), `<datos>/sprint-actual`, `--sprint`, `forja sprint`, trabajos fijados con `FORJA_CAMBIO`, selector en el panel |
| F3 | Cambios desde el panel y regeneración parcial | ✔ | `estado` por caso en el índice (`igual` se copia sin modelo), `pendingSpecInputs` (sólo cambios y respuestas nuevos), rutas `/v1/planeacion/especificacion/cambios` y cambio de respuestas |
| F4 | Edición manual | ✔ | `spec/edit.ts` (`editUseCase`, `removeUseCase`, validados), formulario en el panel |

Pendiente, fuera de esta entrega:
- El aviso de `base_sha` viejo al aprobar, cuando otro sprint se entregó entretanto (§4). Hoy
  lo cubre la herencia del run, pero falta el aviso explícito.
