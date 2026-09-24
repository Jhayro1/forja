# Mejoras y trabajo futuro

Lista viva de lo que falta y de lo que conviene mejorar. Cada etapa registra aquí lo que detectó
mientras se construía; lo terminado está en [PROGRESO.md](PROGRESO.md) y el plan general en el
[roadmap v2](v2/11-roadmap-y-backlog.md).

Prioridad: **P1** necesario para dar el hito por probado de verdad · **P2** calidad o costo importante · **P3** conveniente.

## 0. Lo que necesita tu máquina (P1)

Todo M0–M6 está implementado y probado con agentes simulados dentro del sandbox real. Estas pruebas
sólo se pueden hacer con tus sesiones de Claude y Codex:

1. **V2-038 · demo real**: correr las 25 tareas de la bodega con Claude y Codex a la vez (1.1).
2. **Conformidad del gateway MCP** con los CLI reales (4.1).
3. **Piloto** con runs reales para calibrar N y el enrutamiento (3.1).
4. **Evaluar el grafo** con el historial real antes de activarlo por defecto (5.1).
5. **Publicar en npm** (3.9).

## 1. Para cerrar M3

| # | Prioridad | Qué | Por qué / cómo |
|---|---|---|---|
| 1.1 | P1 | **V2-038 · demo real**: correr las 25 tareas de la bodega con Claude y Codex a la vez | Hasta ahora la ejecución sólo corrió con agentes simulados. Medir: tareas que pasan al primer intento, reintentos por causa, tiempo real contra la estimación (~67 min con 3 agentes), consumo por rol. Guardar la evidencia (informe + `forja estado --json` + `forja piloto`) en `m3/` como se hizo con `m0/` |
| 1.2 | ✅ | **V2-030 · perfil y baseline al importar** | Hoy el perfil (instalar/build/test) lo propone el planeador al dividir. Falta: detectarlo de forma estática al importar, aprobarlo, y correr una línea base en sandbox (¿los tests del repo ya pasan antes de tocar nada?) para no culpar a los agentes de fallos previos — **Hecho:** `forja perfil` (ver, aprobar, linea-base). La detección estática (Node, Python, Go y Rust, en un registro extensible) sólo lee manifiestos y la muestra `forja importar`. El perfil aprobado queda en `forja.yaml` y el planeador ya no puede cambiarlo. La línea base corre el perfil en el sandbox sobre el último commit: los pasos que ya fallaban no se le cobran a las tareas y el planeador los recibe al dividir. |
| 1.3 | ✅ | Versión instalable | Hecho en M4 (V2-043): `npm run probar:paquete`. Falta publicar (3.9) |
| 1.4 | ✅ | `forja run --solo <tarea>` | Está en el contrato de [v2/10](v2/10-cli-ui-y-api.md); útil para depurar una tarea sin lanzar el resto. No debe saltarse dependencias pendientes — **Hecho:** `forja run --solo T-xxx` lanza sólo esa tarea; se niega si alguna dependencia no está integrada o si la tarea espera algo de ti, y termina el run en «pausado» al integrarla. |
| 1.5 | ✅ | Control por tarea: `pausar`, `reanudar`, `reasignar` a otro modelo permitido | También en v2/10. El dominio ya tiene el estado `pausada`; falta el comando y respetar la política al reasignar — **Hecho:** `forja pausar`, `forja reanudar` y `forja reasignar <tarea> <proveedor:modelo>` (también en el panel y la API). Pausar un agente en curso lo detiene y conserva su trabajo; reanudar vuelve a `lista`, `pendiente` o re-verifica el candidato; reasignar sólo acepta modelos de los roles de `forja.yaml`. |

## 2. Detectadas al construir M3

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 2.1 | ✅ | **Tarea «ya cumplida» tras un cambio de plan** | Si una tarea replanificada ya queda satisfecha con el código heredado, el agente no cambia nada y eso cuenta como fallo de calidad (3 intentos → bloqueada). Propuesta: si no hay cambios pero la verificación completa pasa, integrarla como «sin cambios» con evidencia — **Hecho:** si el agente no cambia nada y termina bien, se corre la verificación completa sobre la base; si pasa (con pruebas o revisión como evidencia) se integra «sin cambios» con el paso `sin_cambios` registrado. Sin evidencia sigue siendo un fallo de calidad. |
| 2.2 | ✅ | **Pausas por cuota visibles desde otros procesos** | `engine.paused` vive en memoria del proceso que ejecuta: el tablero, el panel y `forja estado` no pueden mostrar «Claude: cuota agotada hasta 14:30». Persistirlas como eventos (`proveedor.pausado`) — **Hecho:** evento `proveedor.pausado` y tabla `provider_pauses`; `forja estado`, `forja proveedores`, el tablero y el panel las muestran, y `forja proveedores reanudar` las levanta. |
| 2.3 | ✅ | **Dividir `run/orchestrator.ts` (≈850 líneas)** | Separar responsabilidades (SRP) detrás de interfaces: `Scheduler`, `TaskLauncher` (worktree + contexto + gateway + lanzamiento), `TaskVerifier`, `Integrator` (cola + CAS) y `Reconciler`. Permite pruebas unitarias rápidas de cada parte sin Git ni procesos — **Hecho:** `run/orchestrator.ts` pasó de 812 a ~190 líneas y sólo coordina. Las etapas viven en `run/pipeline/`: `RunContext`, `JobRunner`, `selectLaunches` (política pura, con pruebas unitarias), `TaskLauncher`, `OutcomeHandler`, `TaskVerifier`, `Integrator`, `Reconciler` y `Delivery`; `records.ts`, `start.ts` y `task-control.ts` completan el módulo. |
| 2.4 | ✅ | **Cambio de especificación a mitad de run** | V2-037 cubre un plan nuevo sobre la misma spec. Falta `forja especificar` en fase ejecutar con invalidación transitiva: tareas cuyos criterios cambiaron → invalidadas; dependientes → a revisar. El grafo de M6 ya tiene las aristas necesarias (criterio → tarea → archivos) — **Hecho:** `forja especificar --cambio "…"` funciona en «aprobar» y a mitad de run (toma el candado del run y deja el cambio en «dividir»). El run siguiente hereda sólo lo que no tocó el cambio: compara el contenido de requisitos, reglas, entidades, casos y criterios (una regla que cambia afecta a sus casos y a los criterios de esos casos) y rehace además, transitivamente, lo que depende de una tarea rehecha. `forja run` muestra qué se rehace y por qué. |
| 2.5 | ✅ | **Lint y formato en CI** | No hay ESLint/Prettier (o Biome). Agregar reglas mínimas (imports sin usar, `no-floating-promises`, orden de imports) y correrlas en CI junto al typecheck — **Hecho:** Biome (lint + formato + orden de imports, incluido `noFloatingPromises`) con `npm run lint`; corre en CI antes del typecheck y dentro de `npm run check`. Se formateó el código una sola vez. |
| 2.6 | ✅ | Menos sondeo | El bucle y el tablero consultan cada segundo. Con `fs.watch` sobre resultado/latido de cada lanzamiento se reacciona al instante y se lee menos disco — **Hecho:** `Waker` y `DirWatchSet` (`util/waker.ts`): el bucle del orquestador despierta al terminar un trabajo, al aparecer el resultado de un lanzamiento o al escribirse la base (una respuesta o una pausa desde otro proceso); el sondeo queda como respaldo de 2 s. `forja logs -f` también reacciona a eventos de archivo. |
| 2.7 | ✅ | Lectura incremental de spools | El tablero relee los últimos 64 KB de cada agente en cada refresco. Guardar desplazamiento por lanzamiento — **Hecho:** `SpoolFollower`: lee por desplazamiento sólo lo nuevo, completa líneas cortadas y conserva el estado del parser (Codex ve el flujo completo y en orden). El tablero y el panel reutilizan un seguidor por lanzamiento. |
| 2.8 | ✅ | Rotación del registro del run | `runs/<run>/registro.log` crece sin límite; la verdad sigue en los eventos — **Hecho:** `RunLog` rota por tamaño (2 MB) y conserva 3 generaciones; la cola continúa en la generación anterior justo después de rotar. |
| 2.9 | ✅ | Pruebas ya verdes: una sola consulta a Git | `greenTests` hace un `merge-base --is-ancestor` por tarea integrada; con `git rev-list <tip>` una vez basta — **Hecho:** `greenTests` hace un solo `git rev-list <tip> ^<base>` por verificación. |
| 2.10 | ✅ | Tokens y costo de Codex en vivo | Codex informa uso al final del turno; mostrar «medido / estimado / desconocido» como pide v2/10 — **Hecho:** Actividad en vivo con `tokensKind` (medido, estimado por el texto intercambiado o desconocido) y consumo por rol con `costKind`: si el proveedor no informa costo, se estima con `~/.forja/precios.yaml` y se marca como estimado o mixto en `estado`, el tablero y el panel. |
| 2.11 | ✅ | Modo demo más explícito | `FORJA_SIMULACION` sólo afecta modelos `simulado:*`; aun así, mostrar un aviso visible en `run` y en el tablero cuando está activo — **Hecho:** Aviso «MODO DEMO» en `forja run`, `forja estado`, el tablero y el panel, y `modo_demo` en `--json`, siempre que `FORJA_SIMULACION` está activo. |
| 2.12 | ✅ | Textos al usuario centralizados | Los mensajes en español están junto al código; un catálogo único facilita revisarlos y traducirlos — **Hecho:** `src/i18n/textos.ts` concentra el vocabulario compartido: estados de tarea y de acción, fases, pendientes, origen de los datos y aviso de demo. La CLI y el tablero lo importan y el panel lo recibe por `GET /v1/textos`, sin diccionarios propios. Los mensajes propios de un contexto siguen junto a su código. |

## 3. Detectadas al construir M4

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 3.1 | P1 | **Correr el piloto con datos reales** | El protocolo de v2/09 pide 12 cambios fijos × 3 repeticiones × N=2/3/4. La herramienta está (`forja piloto`); faltan los runs con Claude y Codex — **Avance:** ya hay herramienta para correrlo sin intervención: `forja piloto correr --corpus` (3.2). |
| 3.2 | ✅ | Comando que ejecute el corpus del piloto | `forja piloto correr --corpus corpus.yaml`: clona repos y SHAs fijos, alterna el orden y repite cada condición, sin intervención manual — **Hecho:** `forja piloto correr --corpus corpus.yaml`. Cada cambio fija repo, SHA, spec y plan: clona el commit, siembra el cambio aprobado en un almacén propio y lo corre con cada N y repetición, rotando el orden de N y de los cambios. No pide intervención: un run que necesita al usuario cuenta como no aceptado y un error no frena el resto. El informe y `resultados.json` quedan en `.forja/piloto/corpus-<fecha>`. |
| 3.3 | ✅ | Aislamiento en la conformidad cuando el modelo se niega | Si el modelo rehúsa intentar leer/escribir fuera, la comprobación pasa sin haber puesto a prueba el sandbox. Registrar «el modelo se negó» y apoyarse en la prueba del runner — **Hecho:** Si el modelo no intenta salir (ninguna herramienta toca los canarios, `..` ni rutas fuera de su carpeta), la prueba queda «desconocido: el modelo se negó», y la nueva prueba `aislamiento_sandbox` comprueba el mismo límite con comandos (`cat` y `touch`) dentro del sandbox, sin depender del modelo. |
| 3.4 | ✅ | Vista de planeación en el panel | El panel cubre ejecución, acciones y memoria. Falta conversación del planeador, decisiones, preguntas de la spec y el plan por olas antes de aprobar — **Hecho:** Vista «Planeación» en el panel (módulo `planeacion` de la API). Muestra el descubrimiento (alcance, decisiones, preguntas abiertas y bloqueos, con botón para aprobar), la conversación reciente, la spec con casos de uso y problemas, las preguntas de la spec (se responden desde el panel) y el plan por olas con estimación, perfil y botón para aprobar. Verificada en Chromium. |
| 3.5 | ✅ | Un solo sondeo de eventos para todas las conexiones SSE | Cada pestaña sondea SQLite cada 500 ms; un difusor compartido reduce lecturas — **Hecho:** `FeedBroadcaster`: un solo sondeo del almacén para todas las conexiones SSE, activo sólo mientras hay oyentes. Cada conexión se pone al día desde su cursor y, con contrapresión, deja de escribir y retoma al drenar. |
| 3.6 | ✅ | Estado incremental en el panel | Cada evento vuelve a pedir el estado completo; usar ETag o diferencias — **Hecho:** Las lecturas de la API llevan `ETag` y responden `304` con `If-None-Match`; el panel no vuelve a pintar si nada cambió. |
| 3.7 | ✅ | Idempotencia persistente en la API | Las claves viven en memoria de `forja ui`. Las acciones de dominio ya son seguras de repetir (aprobar dos veces no duplica; responder dos veces da 409) — **Hecho:** `SqliteIdempotencyStore` (tabla `api_idempotency` en la base del checkout, 24 h). La clave se acota por método y ruta, no por sesión, así que un reintento tras reiniciar `forja ui` repite la respuesta; la misma clave con otro cuerpo da 422. |
| 3.8 | ✅ | Reprobar automáticamente al detectar una versión nueva del CLI | `forja run` bloquea y pide `forja conformidad`; podría ofrecer correrla ahí mismo — **Hecho:** `forja run` ofrece probar en ese momento los modelos sin conformidad, por ejemplo tras actualizar su CLI (pregunta en TTY, o con `--probar-conformidad`). `certifyModels` es la misma rutina que usa `forja conformidad`. |
| 3.9 | P1 | **Publicar en npm** | `forja` y `forja-cli` están ocupados; el paquete es `@jhayro1/forja`. Verificar que el scope exista en npm y sea tuyo; luego `npm publish` desde CI con provenance — **Avance:** flujo `publicar` listo (etiqueta `vX.Y.Z` → lint, typecheck, pruebas, instalación limpia y `npm publish --provenance`) y guía en `docs/guias/PUBLICAR.md`. Falta sólo lo tuyo: confirmar el scope y cargar `NPM_TOKEN`. |
| 3.10 | ✅ | `env -S` en el shebang | Silencia el aviso experimental de SQLite; requiere coreutils ≥ 8.30 (no está en BusyBox/Alpine). Retirarlo cuando `node:sqlite` sea estable — **Hecho:** El binario es `dist/cli/bin.js` con `#!/usr/bin/env node`: filtra sólo el aviso experimental de SQLite antes de cargar la CLI, sin `env -S`. `probar:paquete` comprueba que no se filtre el aviso. |
| 3.11 | ✅ | Node 22 vs 24 | `engines` exige 24.11 y `doctor` lo marca, pero la suite pasa en 22; decidir si se baja el mínimo — **Hecho:** Decidido: el mínimo pasa a Node 22.13 (`node:sqlite` sin bandera). `engines`, `forja doctor` y la guía de instalación lo reflejan, y el CI corre en Node 22 y 24. |
| 3.12 | ✅ | Aplicar el enrutamiento recomendado | El piloto informa la calidad por modelo pero no cambia `roles`; ofrecer `--aplicar-roles` con confirmación — **Hecho:** `forja piloto --aplicar-roles` (con confirmación, o `--si`) reordena `trabajador` y `complejo` cuando un modelo permitido acepta claramente más al primer intento, con 5 o más tareas por modelo y más de 10 puntos de diferencia. Sin `--aplicar-roles`, `forja piloto` sólo lo sugiere. |

## 4. Detectadas al construir M5

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 4.1 | P1 | **Probar el gateway MCP con Claude y Codex reales** | La configuración (`--mcp-config` en Claude, `-c mcp_servers.forja…` en Codex) está hecha y probada con el agente simulado dentro del sandbox, no con los CLI reales. Agregarlo a `forja conformidad` |
| 4.2 | P2 | Ejecutor de acciones dentro de bwrap | Hoy es un proceso aparte con entorno y directorio vacíos, DNS fijado y destinos internos bloqueados, pero sin aislamiento de disco. Llevarlo al sandbox con red sólo al host de la conexión |
| 4.3 | P2 | Llavero del sistema para la clave de la bóveda | libsecret/Keychain en vez de prompt o `FORJA_BOVEDA_CLAVE` (visible a otros procesos del mismo usuario) |
| 4.4 | P2 | Ejecutar acciones desde el panel | El panel aprueba y descarta; ejecutar exige la bóveda y se hace en la terminal. Opción: `forja ui --boveda` con cierre por inactividad |
| 4.5 | P2 | Más operaciones tipadas | Correo (sin idempotencia: conciliación humana obligatoria), DNS, webhooks; «deshacer» como acción nueva con su propia aprobación |
| 4.6 | ✅ | Reintentos de entorno acotados en todas partes | Se acotó el lanzamiento (3 intentos → bloqueada). Revisar el mismo patrón en la instalación de dependencias y la integración — **Hecho:** `env_failures` persistido por tarea: lanzamiento, instalación, verificación, integración e interrupciones del agente se acotan a 3 fallos de entorno y luego la tarea se bloquea con el motivo. |
| 4.7 | P3 | Gateway tras reiniciar `forja run` | Un agente que siguió trabajando en segundo plano pierde su socket y sus llamadas MCP fallan hasta su siguiente intento |
| 4.8 | P3 | Conciliación automática por consulta | Para servicios no idempotentes pero consultables (`GET /pedidos?clave=`), comprobar el efecto antes de pedir una decisión humana |
| 4.9 | P3 | Rotar copias viejas de la bóveda | `boveda/copias` crece y conserva valores borrados (cifrados); ofrecer purga explícita |
| 4.10 | P3 | Esquemas de salida de herramientas MCP externas | Hoy se reenvía texto; validar `outputSchema` cuando el servidor lo declare |

## 5. Detectadas al construir M6

| # | Prioridad | Qué | Detalle |
|---|---|---|---|
| 5.1 | P1 | **Evaluar el grafo con historial real** | `forja memoria evaluar` mide contra los archivos que los agentes leyeron por su cuenta. El agente simulado no lee archivos, así que sólo hay datos reales después de runs con Claude/Codex. El modo `grafo` queda opcional (`contexto.modo`) hasta que gane con datos, como pide v2/09 |
| 5.2 | P2 | Parser con árbol sintáctico | Los extractores son léxicos (sin dependencias). No siguen llamadas entre funciones ni re-exportaciones hasta el símbolo final. tree-sitter daría eso a cambio de una dependencia nativa |
| 5.3 | P2 | Alias de tsconfig y `exports` de package.json | Hoy `@/x` y similares quedan «sin resolver» (visibles en `forja memoria construir`); leer `paths`/`baseUrl` los convertiría en aristas seguras |
| 5.4 | P2 | Contexto adicional bajo pedido | v2/08: el agente pide archivos o decisiones con motivo (p. ej. herramienta MCP `pedir_contexto`) y Forja lo autoriza y registra, en vez de leer medio repo sin control |
| 5.5 | P2 | Índice de la rama de integración para el panel | `forja memoria construir` indexa el checkout actual; durante un run cada tarea se indexa desde su worktree. Indexar también la punta de integración para que el panel muestre el estado del cambio en curso |
| 5.6 | P3 | Más lenguajes | Go, Rust, Java: una implementación de `LanguageExtractor` y su matriz de fixtures cada uno |
| 5.7 | P3 | Lecciones con conflicto y caducidad | Mostrar cuando una lección contradice una decisión aprobada, y marcarla para revisar cuando cambian los archivos de su ámbito |
| 5.8 | P3 | Hash desde el índice de git | Se lee y hashea cada archivo (30 ms en 138 archivos). En repos grandes, `git ls-files -s` da el hash sin leer el contenido |
| 5.9 | P3 | Embeddings opcionales | Para ubicar puntos de entrada en repos grandes; decidir antes proveedor, privacidad y costo (v2/08) |

## 6. Tablero de terminal (siguientes versiones)

| # | Prioridad | Qué |
|---|---|---|
| 6.1 | P2 | Diff con color y navegación por archivo |
| 6.2 | P2 | Filtro de tareas por estado y búsqueda en logs (`/`) |
| 6.3 | P3 | Vista de dependencias (grafo en texto: qué espera a qué, camino crítico) |
| 6.4 | P3 | Aprobar el plan y las acciones desde el tablero (con el mismo resumen que el panel) |
| 6.5 | P3 | Tiempo estimado restante con la estimación del plan corregida por lo ya medido |

## 7. Ideas a evaluar (sin compromiso)

- **Integración especulativa por lotes**: hoy se integra de a una tarea (seguro pero serial). Con muchas tareas verificadas a la vez, probar un lote y bisecar sólo si falla.
- **Soporte macOS**: bubblewrap es sólo Linux. Evaluar `sandbox-exec` o contenedores con el mismo contrato de aislamiento.
- **Notificaciones** (escritorio, Telegram, correo) cuando algo queda «pendiente de ti», como acción externa tipada con control explícito de qué datos salen.
- **Usar Forja para desarrollar Forja**, con una versión estable separada para no supervisarse a sí misma (v2/11).
