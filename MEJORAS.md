# Mejoras y trabajo futuro

Lista viva de lo que falta y de lo que conviene mejorar, ordenada por prioridad dentro de cada
sección. Lo terminado se registra en [PROGRESO.md](PROGRESO.md); el plan general está en el
[roadmap v2](v2/11-roadmap-y-backlog.md).

Prioridad: **P1** bloquea cerrar el hito · **P2** calidad o costo importante · **P3** conveniente.

## 1. Para cerrar M3

| # | Prioridad | Qué | Por qué / cómo |
|---|---|---|---|
| 1.1 | P1 | **V2-038 · demo real**: correr las 25 tareas de la bodega con Claude y Codex a la vez | Es la prueba que falta: hasta ahora la ejecución sólo corrió con agentes simulados. Necesita tu máquina con las dos sesiones iniciadas. Medir: tareas que pasan al primer intento, reintentos por causa, tiempo real contra la estimación (~67 min con 3 agentes), consumo por rol. Guardar la evidencia (informe + `forja estado --json`) en `m3/` como se hizo con `m0/` |
| 1.2 | P1 | **V2-030 · perfil y baseline al importar** | Hoy el perfil (instalar/build/test) lo propone el planeador al dividir. Falta: detectarlo de forma estática al importar, aprobarlo, y correr una línea base en sandbox (¿los tests del repo ya pasan antes de tocar nada?) para no culpar a los agentes de fallos previos |
| 1.3 | ✅ | **Versión instalable** | Hecho en M4 (V2-043): `npm run probar:paquete`. Falta publicar (ver 6.9) |
| 1.4 | P2 | `forja run --solo <tarea>` | Está en el contrato de [v2/10](v2/10-cli-ui-y-api.md); útil para depurar una tarea sin lanzar el resto. No debe saltarse dependencias pendientes |
| 1.5 | P2 | Control por tarea: `pausar`, `reanudar`, `reasignar` a otro modelo permitido | También en v2/10. El dominio ya tiene el estado `pausada`; falta el comando y respetar la política al reasignar |

## 2. Mejoras técnicas detectadas al construir M3

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 2.1 | P2 | **Tarea «ya cumplida» tras un cambio de plan** | Si una tarea replanificada ya queda satisfecha con el código heredado, el agente no cambia nada y eso cuenta como fallo de calidad (3 intentos → bloqueada). Propuesta: si no hay cambios pero la verificación completa pasa, integrarla como «sin cambios» con evidencia |
| 2.2 | P2 | **Pausas por cuota visibles desde otros procesos** | `engine.paused` vive en memoria del proceso que ejecuta: el tablero y `forja estado` no pueden mostrar «Claude: cuota agotada hasta 14:30». Persistirlas como eventos (`proveedor.pausado`) y mostrarlas en la sección Consumo |
| 2.3 | P2 | **Dividir `run/orchestrator.ts` (≈750 líneas)** | Separar responsabilidades (SRP) detrás de interfaces: `Scheduler` (qué lanzar y cuándo), `TaskLauncher` (worktree + contexto + lanzamiento), `TaskVerifier`, `Integrator` (cola + CAS) y `Reconciler`. Permite pruebas unitarias rápidas de cada parte sin Git ni procesos, y deja el bucle como coordinación pura |
| 2.4 | P2 | **Cambio de especificación a mitad de run** | V2-037 cubre un plan nuevo sobre la misma spec. Falta `forja especificar` en fase ejecutar con invalidación transitiva: tareas cuyos criterios cambiaron → invalidadas; dependientes → a revisar |
| 2.5 | P2 | **Lint y formato en CI** | No hay ESLint/Prettier (o Biome). Agregar reglas mínimas (imports sin usar, `no-floating-promises`, orden de imports) y correrlas en CI junto al typecheck |
| 2.6 | P3 | **Menos sondeo** | El bucle y el tablero consultan cada segundo. Con `fs.watch` sobre resultado/latido de cada lanzamiento y un contador de eventos en SQLite, se reacciona al instante y se lee menos disco |
| 2.7 | P3 | **Lectura incremental de spools** | El tablero relee los últimos 64 KB de cada agente en cada refresco. Guardar desplazamiento por lanzamiento y leer sólo lo nuevo |
| 2.8 | P3 | **Rotación del registro del run** | `runs/<run>/registro.log` crece sin límite. Rotar por tamaño o conservar sólo las últimas N líneas; la verdad sigue en los eventos |
| 2.9 | P3 | **Pruebas ya verdes: una sola consulta a Git** | `greenTests` hace un `merge-base --is-ancestor` por tarea integrada. Con `git rev-list <tip>` una vez (o cacheando por punta) baja a una llamada |
| 2.10 | P3 | **Tokens y costo de Codex en vivo** | Codex informa uso al final del turno: el tablero muestra `?` mientras trabaja. Mostrar «medido / estimado / desconocido» como pide v2/10 |
| 2.11 | P3 | **Modo demo más explícito** | `FORJA_SIMULACION` sólo afecta modelos `simulado:*`, así que no puede suplantar a Claude o Codex; aun así, mostrar un aviso visible en `run` y en el tablero cuando está activo |
| 2.12 | P3 | Textos al usuario centralizados | Hoy los mensajes en español están junto al código. Un catálogo único facilita revisarlos y traducirlos |

## 6. Mejoras detectadas en M4

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 6.1 | P1 | **Correr el piloto con datos reales** | El protocolo de v2/09 pide 12 cambios fijos × 3 repeticiones × N=2/3/4. La herramienta está (`forja piloto`); faltan los runs con Claude y Codex |
| 6.2 | P2 | Comando que ejecute el corpus del piloto | `forja piloto correr --corpus corpus.yaml`: clona repos y SHAs fijos, alterna el orden y repite cada condición, sin intervención manual |
| 6.3 | P2 | Aislamiento en la conformidad cuando el modelo se niega | Si el modelo rehúsa intentar leer/escribir fuera, la comprobación pasa sin haber puesto a prueba el sandbox. Registrar «el modelo se negó» y apoyarse en la prueba del runner (que ya ejerce el sandbox sin modelo) |
| 6.4 | P2 | Vista de planeación en el panel | Hoy el panel cubre ejecución. Falta conversación del planeador, decisiones, preguntas de la spec y el plan por olas antes de aprobar |
| 6.5 | P3 | Un solo sondeo de eventos para todas las conexiones SSE | Cada pestaña sondea SQLite cada 500 ms; un difusor compartido reduce lecturas |
| 6.6 | P3 | Estado incremental en el panel | Cada evento vuelve a pedir el estado completo; usar ETag o diferencias |
| 6.7 | P3 | Idempotencia persistente en la API | Las claves viven en memoria de `forja ui`. Las acciones actuales ya son seguras de repetir (una segunda respuesta devuelve 409), pero las de M5 no deben depender de eso |
| 6.8 | P3 | Reprobar automáticamente al detectar una versión nueva del CLI | `forja run` bloquea y pide `forja conformidad`; podría ofrecer correrla ahí mismo |
| 6.9 | P1 | Publicar en npm | Verificar que el scope `@jhayro1` exista en npm y sea tuyo; luego `npm publish` desde CI con provenance |
| 6.10 | P3 | `env -S` en el shebang | Silencia el aviso experimental de SQLite; requiere coreutils ≥ 8.30 (no está en BusyBox/Alpine). Retirarlo cuando `node:sqlite` sea estable |
| 6.11 | P3 | Node 22 vs 24 | `engines` exige 24.11 y `doctor` lo marca, pero la suite pasa en 22; decidir si se baja el mínimo o se usa algo exclusivo de 24 |
| 6.12 | P3 | Aplicar el enrutamiento recomendado | El piloto informa la calidad por modelo pero no cambia `roles`; ofrecer `--aplicar-roles` con confirmación |

## 3. Tablero (siguientes versiones)

| # | Prioridad | Qué |
|---|---|---|
| 3.1 | P2 | Diff con color y navegación por archivo |
| 3.2 | P2 | Filtro de tareas por estado y búsqueda en logs (`/`) |
| 3.3 | P3 | Vista de dependencias (grafo en texto: qué espera a qué, camino crítico) |
| 3.4 | P3 | Aprobar el plan desde el tablero (con el mismo resumen que `forja plan`) |
| 3.5 | P3 | Tiempo estimado restante con la estimación del plan corregida por lo ya medido |

## 4. Hitos siguientes (roadmap)

| Hito | Qué | Nota |
|---|---|---|
| M4 | **API local + SSE** (V2-041) y **panel web** | El modelo de lectura `run/snapshot.ts` y las funciones de dominio que usa el tablero ya son la capa que la API debe exponer: el panel no necesita lógica nueva, sólo transporte, sesión y CSRF |
| M4 | **Conformidad continua de proveedores** (V2-040) | Correr la suite de conformidad ante cada versión nueva de `claude`/`codex` o modelo nuevo antes de habilitarlo |
| M4 | **Piloto de calidad, costo y paralelismo** (V2-042) | Calibrar N por defecto y el enrutamiento por modelo con datos reales (depende de 1.1) |
| M4 | **Empaquetado y guías** (V2-043) | Instalación limpia, guía de recuperación y de seguridad, limitaciones publicadas |
| M5 | Bóveda de secretos y conexiones | Secretos inyectados al proceso, nunca al prompt; acciones externas con vista previa y aprobación |
| M6 | Memoria en grafo | Contexto por relevancia a partir de spec + parser TS/JS; lecciones aprendidas reutilizables |

## 5. Ideas a evaluar (sin compromiso)

- **Integración especulativa por lotes**: hoy se integra de a una tarea (seguro pero serial). Con muchas tareas verificadas a la vez, probar un lote y bisecar sólo si falla.
- **Soporte macOS**: bubblewrap es sólo Linux. Evaluar `sandbox-exec` o contenedores con el mismo contrato de aislamiento (sin red salvo la API, sin HOME real).
- **Notificaciones** (escritorio, Telegram, correo) cuando algo queda «pendiente de ti», con control explícito de qué datos salen (v2/10 lo pide después de las conexiones de M5).
- **Usar Forja para desarrollar Forja** después de M3, con una versión estable separada para no supervisarse a sí misma (v2/11).
