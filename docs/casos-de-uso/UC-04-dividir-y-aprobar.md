# UC-04 · Dividir en tareas y aprobar el plan

**Actores:** Planeador, Usuario · **Reglas:** R-01, R-02, R-10

**Precondiciones:** `spec.json` válido; perfil del proyecto detectado.

## Flujo principal
1. El código genera el borrador de tareas por reglas ([05](../05-generacion-barata.md)).
2. El planeador ajusta el borrador en una llamada (partir, unir, dependencias, archivos, complejidad) y marca la ola 0 de contratos.
3. El código valida: sin ciclos, sin archivos compartidos dentro de una ola, cada criterio cubierto por una tarea.
4. Calcula olas, asigna nivel y presupuesto, y estima el costo y el uso de cada suscripción.
5. Escribe `tareas/T-*.yaml` y `plan.md`.
6. Muestra la puerta: casos de uso, tareas por ola, grafo, estimación y conexiones requeridas.
7. El usuario aprueba (`forja aprobar plan` o botón) → evento `puerta.aprobada(plan)`.

## Flujos alternos
- **A1 · El usuario pide cambios al plan:** se los dice al planeador; se repiten 2–6.
- **A2 · Una tarea requiere una conexión que no existe:** la puerta la marca en rojo con el botón «crear conexión» (UC-11); se puede aprobar el resto dejando esas tareas en espera.
- **A3 · Estimación por encima del presupuesto del proyecto:** aviso destacado; aprobar exige confirmar el monto.

## Excepciones
- **E1 · Ciclo de dependencias:** se devuelve al planeador con el ciclo exacto; si persiste, se muestra al usuario.
- **E2 · Dos tareas de una ola comparten un archivo:** el código las serializa (una depende de la otra) y lo anota.
- **E3 · Un criterio sin tarea que lo cubra:** se crea una tarea `aceptacion` para ese criterio.

## Criterios de aceptación
- **CA-1** Dado un plan sin aprobar, cuando ejecuto `forja run`, entonces no se lanza ningún trabajador y se me indica aprobar.
- **CA-2** Dadas T-1 y T-2 en la misma ola que declaran `src/a.ts`, cuando se validan, entonces quedan en olas distintas.
- **CA-3** Dado un plan aprobado, cuando ejecuto `forja run --estimar`, entonces veo el costo por nivel sin que se llame a ningún modelo.
