# Forja v3 · Plan de mejoras: seis roles, ciclo completo y panel nuevo

**Fecha:** 2026-09-29 · **Estado:** en implementación en la rama `mejoras/v3` (ver §12) · **Parte de:** `main` en `825de32`

Este plan aterriza el documento «Sistema de agentes IA para construir proyectos por etapas» (el
documento de referencia) sobre lo que Forja ya hace. No parte de cero: M0–M6, las mejoras de
[MEJORAS.md](../MEJORAS.md) y el panel React/shadcn ([ADR-013](../docs/decisiones/ADR-013-panel-shadcn.md))
ya cubren más de la mitad. Aquí se dice qué se reutiliza, qué se amplía y qué es nuevo, tanto en
el trabajo (motor, roles, datos) como en la interfaz.

Leer en orden: §1 qué hay hoy → §2 principios que no cambian → §3 correspondencia de conceptos →
§4 los seis roles → §5 el ciclo nuevo → §6 la interfaz → §7 backend y datos → §8 fases y backlog →
§9 criterios de aceptación → §10 lo que queda fuera.

---

## 1. Dónde estamos (auditoría rápida)

### 1.1 Lo que ya funciona y se conserva

| Área | Hoy en Forja | Dónde |
|---|---|---|
| Descubrir | Conversación con el planeador, resumen, decisiones, preguntas abiertas, bloqueos y «Aprobar y seguir» | `src/planner/`, `panel/src/screens/inicio.tsx` |
| Especificar | `spec.json` con revisión, casos de uso, reglas, entidades y criterios; las plantillas escriben los `.md` | `src/spec/`, ADR-004 |
| Dividir | Tareas con tipo, complejidad, criterios, archivos que escribe, dependencias y olas; estimación | `src/plan/` |
| Aprobar | Aprobación ligada al hash del plan; perfil y línea base | `src/plan/approve.ts`, `src/domain/approval.ts` |
| Ejecutar | Orquestador determinista, N agentes en paralelo en worktrees y sandbox, reintentos acotados, pausar/reanudar/reasignar | `src/run/`, `src/run/pipeline/` |
| Verificar | Instalar → build/typecheck → lint → tests propios y ya verdes → anti-trampas → revisor por criterio | `src/verify/verify.ts` |
| Integrar | Fusión en serie o por lotes con bisección; entrega en `forja/entrega/<cambio>` | `pipeline/integrator.ts`, `batching.ts` |
| Cambio de alcance | `especificar --cambio` con invalidación transitiva a mitad de run | `src/run/invalidation.ts` |
| Recuperación | Estado por eventos en SQLite, runner supervisado, backups | ADR-006, `src/ops/` |
| Conexiones | Bóveda cifrada, acciones tipadas aisladas, gateway MCP, auditoría, notificaciones | `src/vault/`, `src/actions/`, `src/mcp/` |
| Memoria | Grafo en SQLite, lecciones revisadas | `src/memory/` |
| Panel | 10 pantallas en React + shadcn, SSE en vivo, ETag, CSRF, idempotencia, tema claro/oscuro | `panel/` |

### 1.2 Lo que falta frente al documento de referencia

1. **Sólo hay tres roles reales** (planeador, trabajador/complejo, revisor). Faltan **Auditor**,
   **QA** e **Integrador** de servicios. El «Orquestador» existe, pero es código y no se ve como rol.
2. **El ciclo termina en «Entregado»**. No hay validación del cambio completo (auditoría, QA de
   escenarios), ni **aceptación** de la entrega, ni **publicación** (PR o merge), ni «Continuar» con
   el siguiente bloque.
3. **Un solo cambio a la vez**, sin épicas: no hay backlog de sprints, ni historial con
   lista de control o calendario, ni «siguiente sprint propuesto».
4. **La evidencia no es de primera clase**. Los pasos de verificación y el veredicto del revisor se
   guardan por ejecución, pero no hay una matriz criterio → tarea → evidencia → versión que se pueda
   consultar, ni hallazgos con ciclo de vida propio.
5. **No hay una «siguiente acción» calculada en el servidor**. Cada pantalla deduce qué mostrar a
   partir de la fase.
6. **El panel es un asistente paso a paso**: una columna, un stepper y tarjetas. No tiene resumen
   con indicadores, tablero por columnas, vista de agentes, matriz de calidad, PRD navegable, chat
   lateral contextual, paleta de comandos ni resumen global de varios proyectos.
7. **Catálogo de modelos incompleto**: falta `claude-sonnet-5-5`, y en Codex faltan `gpt-5.6-sol`,
   `gpt-5.6-terra` y `gpt-5.6-luna` (los lista `codex` 0.157.1 en este servidor).

---

## 2. Principios que no cambian

El documento de referencia es genérico. Forja tiene decisiones tomadas que mandan sobre él:

- **El orquestador es código, no un LLM** ([ADR-002](../docs/decisiones/ADR-002-orquestador-determinista.md)).
  El rol «Orquestador» del panel es la cara visible del motor determinista más el planeador. Coordinar
  no gasta tokens; sólo dividir y replanear llaman a un modelo.
- **El repo es la verdad** (ADR-008). PRD, decisiones y contratos viven en el repo como documentos
  generados desde `spec.json`. Las bases de datos son estado de ejecución o índices.
- **`main` nunca se toca sin aprobación explícita.** Publicar (merge o PR) es una acción con su propia
  aprobación ligada al commit exacto.
- **Secretos nunca en el agente ni en el prompt** (ADR-007). El Integrador trabaja contra
  conexiones de la bóveda a través del gateway, nunca con la clave en la mano.
- **Una ejecución terminada no es una tarea validada; una tarea validada no es una entrega aceptada;
  una entrega aceptada no es una versión publicada.** Estos cuatro estados deben verse distintos.
- **Una sola persona, muchos agentes.** Forja no tiene «usuarios con roles»: tiene un **dueño** y
  **varias cuentas de proveedor** (varias de Claude y varias de Codex). Los agentes se reparten
  entre esas cuentas para trabajar en paralelo y seguir cuando una se queda sin cuota (§4.9).
- **Local o en un servidor.** En la PC escucha en `127.0.0.1`, como hoy. En un servidor (Doko) corre
  en modo servidor con **login obligatorio del dueño**: sin sesión no se sirve ninguna ruta (§6.9).
- **CSP estricta del panel**: nada de `innerHTML`/`dangerouslySetInnerHTML`, estilos inline sólo con
  el nonce. Toda librería nueva se revisa contra esto (§6.11).

---

## 3. Correspondencia de conceptos

| Documento de referencia | En Forja | Cambio |
|---|---|---|
| Espacio de trabajo | La instalación local (`~/.forja`) con su registro de proyectos | Ninguno |
| Proyecto | Proyecto registrado (`forja.yaml`, `project_id`) | Se añade objetivo, descripción y etapa |
| Etapa | Nuevo: madurez del proyecto (Definición, Diseño, Construcción, Validación, Entrega, Mantenimiento) | **Nuevo**, calculada y editable |
| Módulo | Área del producto; hoy implícito en los casos de uso | **Nuevo** campo `modulo` en casos de uso y tareas |
| Épica | Nuevo: objetivo grande que agrupa varios sprints | **Nuevo** (V3-500) |
| Sprint | **Cambio** (`cambio` con fases descubrir → … → entregado) | Se amplía: validar, aceptar, publicar |
| Historia | Grupo de tareas de un mismo **caso de uso** de la spec (`UC-…`) | Se deriva de los criterios de cada tarea, sin pedir nada nuevo al planeador |
| Tarea | Tarea del plan (`T-001`), la unidad mínima | Se añaden rol responsable y módulo |
| Criterio de aceptación | Criterio de la spec (`CA-…`) | Ninguno |
| Ejecución | Lanzamiento o intento de una tarea | Se expone como entidad propia en la API |
| Entregable | Diff de la tarea, rama de entrega y documentos | **Nuevo** registro de entregables con versión |
| Evidencia | Pasos de verificación y veredicto del revisor | **Nueva** entidad `validacion` ligada a sha |
| Decisión | Decisiones del descubrimiento | Se versionan y se enlazan a lo afectado |
| Aprobación | `approval.ts` (hash) | Se añaden aceptación de entrega y publicación |

**Jerarquía del trabajo.** Épica → Sprint → Historia → Tarea. Una épica («Facturación») agrupa
sprints; cada sprint es un cambio con su plan aprobado («Pagos parciales»); cada historia agrupa las
tareas de un caso de uso («UC-03 Registrar pago»); y cada tarea es la unidad mínima que ejecuta un
agente. Todas se ven en la pantalla **Historial** (§6.3) como lista de control y como calendario.

**Estados de tarea.** El dominio conserva sus 13 estados (`src/domain/task-state.ts`); el panel los
agrupa en las columnas del documento. No se renombra el dominio.

| Columna del tablero | Estados internos |
|---|---|
| Pendiente | `pendiente` |
| Lista | `lista` |
| En curso | `reservada`, `ejecutando` |
| En validación | `verificando`, `verificada`, `integrando` |
| Completada | `integrada` |
| Bloqueada (transversal, con motivo) | `bloqueada`, `esperando_respuesta`, `pausada` |
| Cancelada (oculta por defecto) | `cancelada`, `invalidada` |

«Por aceptar» no es un estado de tarea en Forja: la aceptación es **del cambio completo** (§5). Así
se evita pedir una aprobación por tarea, que el documento desaconseja para operaciones rutinarias.

**Estados de ejecución** (del documento): en cola, preparando, ejecutando, esperando decisión, pausa
solicitada, pausada, completada, fallida y cancelada. Hoy se derivan de los eventos del lanzamiento;
V3-210 los expone con esos nombres. Hay que distinguir **«pausa solicitada»** de **«pausada»**: el
evento `pausa_confirmada` ya existe, falta mostrar el paso intermedio.

---

## 4. Los seis roles en Forja

Los roles son responsabilidades, no procesos permanentes. Cada uno se configura en `forja.yaml →
roles` con una lista de modelos por orden de preferencia y un esfuerzo (`esfuerzo`), igual que hoy.

| Rol del documento | Rol en `forja.yaml` | Estado | Cuándo actúa | Modelo por defecto propuesto |
|---|---|---|---|---|
| Orquestador | `planeador` + motor | Existe | Descubrir, especificar, dividir, replanear; el motor coordina | `claude:opus`, `codex:gpt-6-astra` |
| Implementador | `trabajador` / `complejo` | Existe | Cada tarea de código | `claude:haiku`/`sonnet`, `codex:gpt-6-luna`/`sol` |
| Integrador | `integrador` | **Nuevo** | Tareas de tipo `integracion` (APIs, BD, webhooks) | `claude:sonnet`, `codex:gpt-6-sol` |
| Revisor | `revisor` | Existe, se amplía | Por tarea (hoy) y por cambio (nuevo) | `codex:gpt-6-sol`, `claude:sonnet` |
| Auditor | `auditor` | **Nuevo** | Una vez por cambio, sobre el diff integrado | `claude:opus`, `codex:gpt-6-astra` |
| QA | `qa` | **Nuevo** | Escribe y corre escenarios sobre la rama integrada | `claude:sonnet`, `codex:gpt-6-sol` |

### 4.1 Orquestador (planeador + motor)

- **Se conserva**: división en tareas y olas, dependencias, paralelismo N, reintentos acotados,
  invalidación por cambio de alcance y detención ordenada.
- **Se añade**:
  - **Siguiente acción** calculada en el servidor (V3-110): una sola función pura que, a partir del
    estado, devuelve `{accion, titulo, motivo, bloqueos[]}`, por ejemplo «Responder la pregunta de
    T-004» o «Aceptar la entrega del cambio "Clientes"». La usan el panel, `forja estado` y `forja siguiente`.
  - **Detección de ciclos sin progreso**: ya existe por tarea (3 intentos). Se amplía al cambio: si
    las correcciones de la fase de validación no cierran hallazgos en 2 rondas, se detiene y pide una
    decisión.
  - **Resumen de avance** al cerrar cada ola y el cambio, generado por plantilla (sin tokens).
  - **Propuesta del siguiente sprint** de la épica, con su motivo (V3-520).
- **Límite** (ya se cumple): una tarea sólo pasa a `integrada` con verificación e integración
  confirmadas, nunca por lo que diga el agente.

### 4.2 Implementador (trabajador / complejo)

- Sin cambios de fondo. Se añade al resultado de cada tarea un **resumen en lenguaje de producto**
  (una o dos frases, pedido en el esquema de salida del agente) además del técnico, para la vista no
  técnica del panel.
- El panel muestra los criterios que la tarea dice cumplir junto al veredicto del revisor, para que
  el usuario vea la diferencia entre «dice que cumple» y «se comprobó».

### 4.3 Integrador (nuevo)

Hoy «integrar» en Forja significa **fusionar en git**, y eso choca con el Integrador del documento
(APIs, BD, webhooks). Decisión:

- En la interfaz, la fusión pasa a llamarse **«Unir a la entrega»**. En el código sigue siendo
  `Integrator`, porque no hay motivo para tocarlo.
- El **rol `integrador`** es un Implementador especializado en tareas `tipo: integracion`, que el
  planeador marca cuando una tarea toca un contrato externo, un esquema de datos o una migración.
- **Qué recibe además**: los contratos (`spec.entidades`, endpoints) y acceso a las conexiones del
  proyecto sólo a través del gateway MCP (herramientas tipadas, nunca la credencial).
- **Qué debe producir**: el adaptador, **una prueba de contrato** (con un servidor simulado o grabado)
  y el manejo de fallos: reintento, idempotencia y errores tipados. La verificación exige la prueba de
  contrato para ese tipo de tarea.
- **Migraciones**: una tarea que crea una migración queda marcada. La publicación exige confirmar
  un procedimiento de copia y vuelta atrás (§5, paso Publicar).
- **Estados de una conexión** en la pantalla de integraciones: Configurada, Verificada (pasó una
  prueba con alcance declarado), Degradada (la última prueba falló y alguna anterior pasó) y
  Desconectada.
- **No se inventan integraciones**: si el cambio no toca servicios externos, el rol no se activa.

### 4.4 Revisor (se amplía)

- **Por tarea (hoy)**: veredicto por criterio (`cumple`, `no_cumple`, `no_verificable`) y hallazgos
  (`alta`, `media`, `baja`). Se añade a cada hallazgo una **clase**: `defecto`, `sugerencia` o
  `requisito_nuevo`. Sólo un `defecto` rechaza; una `sugerencia` se guarda y un `requisito_nuevo` se
  ofrece como cambio de alcance, nunca como corrección silenciosa.
- **Por cambio (nuevo, V3-411)**: una pasada sobre el diff completo de la entrega que arma la
  **matriz requisito → tarea → entrega → evidencia** y detecta criterios que ninguna tarea cubrió o
  que quedaron `no_verificable`.

### 4.5 Auditor (nuevo)

- **Cuándo**: una vez por cambio, cuando todas las tareas están unidas a la entrega; y cuando el
  usuario lo pida.
- **Entradas**: diff completo, arquitectura y reglas de la spec, dependencias añadidas y perfil.
- **Herramientas deterministas primero** (sin tokens, en el sandbox): el auditor de dependencias del
  gestor (`npm audit --json`, `pip-audit`, `cargo audit`, según el perfil), un escáner de secretos
  sobre el diff (reutilizando la redacción de `src/security/`) y un aviso de operaciones destructivas
  (`DROP`, `DELETE` sin `WHERE`, `rm -rf`) en migraciones y scripts. Cada herramienta que falta se
  declara como **«no cubierto»**.
- **Después, el modelo** revisa autenticación, autorización, aislamiento de datos, validación de
  entradas y rendimiento pertinente, y devuelve hallazgos con severidad, impacto, evidencia
  (archivo:línea), recomendación y **condición de cierre**.
- **Bloqueo**: un hallazgo `critica` o `alta` abierto bloquea la aceptación. Se puede registrar una
  **excepción** con justificación, que queda en el historial y se ve en la entrega.
- **Nunca** se muestra «seguro» ni un porcentaje de seguridad; se muestra la cobertura: qué se
  revisó, con qué herramienta y sobre qué commit.

### 4.6 QA (nuevo)

- **Cuándo**: por cambio, sobre la rama integrada, en paralelo con el Auditor.
- **Qué hace**: convierte los casos de uso y los criterios en **escenarios** (pasos, datos, resultado
  esperado) y los ejecuta. Para proyectos web con perfil `preview` (V3-610) usa Playwright en el
  sandbox con capturas como evidencia; si no, pruebas de integración o de API.
- **Resultados con cuatro valores**: `paso`, `fallo`, `bloqueado` (no se pudo ejecutar, con causa) y
  `no_ejecutado`. Un escenario no ejecutado nunca cuenta como aprobado.
- **Fallos**: cada `fallo` genera un **defecto reproducible** (pasos, esperado, obtenido, evidencia)
  y una tarea de corrección vinculada (§5, Validar). Al corregirse, el escenario se vuelve a ejecutar
  **sobre el commit nuevo** antes de cerrar el defecto.
- **Datos**: sólo de prueba, generados en el sandbox. Nunca contra producción.

### 4.7 Hallazgos repetidos

Revisor, Auditor y QA pueden encontrar lo mismo. Un hallazgo nuevo que apunte al mismo archivo y
rango, o al mismo criterio, se **vincula** al existente como otra evidencia en vez de crear otra
tarea de corrección (V3-415).

### 4.8 Coordinación entre agentes en paralelo

Varios agentes trabajan a la vez en el mismo proyecto. Para que no se pisen ni hagan lo mismo dos
veces, necesitan saber qué hace cada uno. Hoy Forja ya evita lo peor:

- Dos tareas sin orden entre sí que pueden **escribir los mismos archivos** nunca corren a la vez
  (recursos implícitos, `src/plan/plan.ts`).
- Cada tarea sólo puede tocar sus globs `escribe`; lo demás se rechaza antes de verificar
  (`outcome-handler.ts`).
- Las pruebas de aceptación de otra tarea están protegidas.

Lo que falta, y se añade:

1. **Bitácora del equipo en el contexto de cada agente** (V3-700). Al lanzar una tarea, su paquete
   de contexto incluye una sección `equipo`:
   - **Trabajando ahora**: las otras tareas en curso, con su objetivo y los archivos que tienen
     reservados, y la instrucción de no depender de su contenido actual.
   - **Ya terminadas en este sprint**: por cada tarea unida, qué archivos cambió, qué exporta
     (funciones, tipos y rutas, sacados del diff) y su resumen. Así la tarea siguiente reutiliza en
     vez de reescribir.
   - **Pendientes que dependen de ti**: quién va a usar lo que produzcas, para que respetes el contrato.
2. **Consulta en vivo** (V3-701): herramienta MCP `equipo` en el gateway que devuelve la bitácora
   actualizada. Sirve para tareas largas, que pueden preguntar a mitad de camino.
3. **Lectura de archivos que otro está cambiando** (V3-702). Si la tarea A **lee** un archivo que la
   tarea B **escribe** y no hay orden entre ellas, el plan lo avisa al dividir y el motor prefiere
   lanzar A después de B cuando hay otra tarea lista para ocupar el hueco.
4. **Nodos de memoria por resultado** (V3-703). Cada tarea unida añade al grafo del proyecto un
   nodo `resultado` (tarea → archivos → símbolos → criterio). La memoria entre sprints usa esos
   nodos: el sprint siguiente sabe qué hizo el anterior sin releerlo todo.
5. **Trabajo duplicado** (V3-704). Si la tarea que se va a lanzar tiene todos sus criterios ya
   cubiertos por lo unido, se verifica primero sobre la base (camino «sin cambios» de MEJORAS 2.1)
   y sólo se lanza el agente si esa verificación falla.

### 4.9 Varias cuentas por proveedor

- **Cuentas**: cada cuenta es una carpeta propia de sesión en `~/.forja/cuentas/<proveedor>/<alias>/`
  (`CLAUDE_CONFIG_DIR` para Claude y `CODEX_HOME` para Codex). Se agregan, se inician, se
  desactivan y se eliminan desde **Ajustes → Proveedores**. La cuenta por defecto del CLI
  (`~/.claude`, `~/.codex`) sigue siendo la cuenta `principal`.
- **Reparto**: al lanzar, el motor elige para el modelo la cuenta activa con menos agentes en curso
  que no esté pausada por cuota. Las pausas de cuota pasan a ser **por cuenta**: si una cuenta se
  queda sin cuota, las demás siguen.
- **Límite por cuenta**: `max_agentes` por cuenta (por defecto 3), además del N global.
- **Trazabilidad**: cada ejecución guarda con qué cuenta corrió, y la pantalla Agentes muestra el
  uso por cuenta.
- Las credenciales siguen sin entrar al prompt: sólo el archivo de sesión de esa cuenta se monta en
  el sandbox (D2-21).

---

## 5. El ciclo nuevo de un cambio

Hoy: `descubrir → especificar → dividir → aprobar → ejecutar → entregado`.

Propuesta (las tres fases nuevas en mayúsculas):

```
descubrir → especificar → dividir → aprobar → ejecutar → VALIDAR → ACEPTAR → entregado → (PUBLICAR)
                                                   ▲            │
                                                   └─correcciones┘
```

| Fase | Quién | Entra con | Sale con | Puerta |
|---|---|---|---|---|
| Descubrir | Orquestador (planeador) | Idea libre, adjuntos | Resumen, decisiones y supuestos marcados | Aprobar descubrimiento (existe) |
| Especificar | Orquestador | Descubrimiento aprobado | Spec/PRD con revisión N | Sin preguntas que bloqueen (existe) |
| Dividir | Orquestador | Spec | Plan con tareas, rol, módulo, olas y estimación | — |
| Aprobar | Usuario | Plan | Plan aprobado (hash) | Aprobar plan (existe) |
| Ejecutar | Implementador, Integrador, Revisor por tarea | Plan aprobado | Todas las tareas unidas a la entrega | Automática |
| **Validar** | Revisor de cambio, Auditor, QA | Rama de entrega en el commit X | Informe de calidad sobre X | Automática, o correcciones |
| **Aceptar** | Usuario | Informe sobre X | Entrega aceptada en X | **Aceptar entrega** o **Solicitar ajustes** |
| Entregado | — | Aceptación | Siguiente cambio propuesto | — |
| **Publicar** (opcional) | Usuario + acción tipada | Entrega aceptada en X | PR creado o merge en `main` | Aprobación ligada a X |

### 5.1 Validar

1. Al unir la última tarea, el motor crea el trabajo `validar` sobre el commit de la punta de la entrega.
2. Revisor de cambio, Auditor y QA corren **en paralelo** (cuentan contra el mismo N).
3. Todo lo que dejan Revisor, Auditor y QA se guarda como **observaciones** (ver §5.1.1) y se
   lista en la pantalla Calidad.
   - Sin observaciones bloqueantes → pasa a **Aceptar**.
   - Con observaciones → **se detiene y te pregunta**. Forja propone un **plan de acción**: tareas
     de corrección vinculadas a cada observación, con su criterio. **Nunca las ejecuta sola, en
     ningún modo de autonomía.** Tú decides en cada propuesta:
     - **Aprobar** el plan tal cual. Se ejecuta como una revisión aditiva: lo ya unido no se
       invalida, y después se repiten sólo los controles afectados.
     - **Editar**: quitar tareas, cambiar su texto u objetivo, o pasar observaciones a «no se hace».
     - **Descartar** una observación con un motivo, que queda en el historial.
     - **Dejar para después**: la observación pasa al backlog como candidata del siguiente sprint.

#### 5.1.1 Observaciones

- Cada observación tiene fuente (revisor, auditor, QA o verificación), severidad, clase (`defecto`,
  `sugerencia` o `requisito_nuevo`), ubicación (archivo:línea o criterio), evidencia, commit y estado.
- **Estados**: `abierta` → `en_plan` → `en_corrección` → `resuelta` (comprobada sobre el commit
  nuevo). Las salidas alternativas son `descartada` (con motivo) y `pospuesta`.
- También se guardan las observaciones del revisor **por tarea** que hoy se pierden cuando la tarea se
  aprueba igual, por ejemplo hallazgos de severidad baja.
- Las observaciones equivalentes se vinculan (§4.7).
4. Toda evidencia guarda el **commit** y el **entorno** (sandbox, versión del perfil). Si la rama
   avanza, la evidencia anterior queda marcada como **«de una versión anterior»**; no se da por buena
   en silencio.

### 5.2 Aceptar

- La pantalla de aceptación muestra el resumen en lenguaje de producto, la matriz de criterios, los
  hallazgos abiertos y las excepciones, las limitaciones declaradas, la vista previa (si la hay), el
  diff y los cambios de alcance ocurridos durante el cambio.
- **Aceptar entrega**: aprobación con actor, fecha y commit. Si la rama cambia después, la aceptación
  queda invalidada.
- **Solicitar ajustes**: el usuario marca qué criterio o resultado debe cambiar. Se abre una ronda
  de corrección (como en Validar) o, si es alcance nuevo, un `especificar --cambio`.

### 5.3 Publicar (opcional y siempre con aprobación)

Forja no despliega nada. Publicar ofrece dos salidas, cada una con su aprobación ligada al commit
aceptado:

1. **Crear PR** en GitHub con `gh`, con el informe de calidad como descripción.
2. **Unir a `main` localmente** (fast-forward o merge), sólo si el usuario lo activó en el proyecto.

Si la entrega contiene **migraciones**, la confirmación lo avisa.

### 5.4 Continuar

Al terminar, el panel propone el siguiente sprint de la épica y explica por qué: sus
dependencias ya están entregadas, tiene la mayor prioridad y comparte módulo con lo recién aceptado.
Las decisiones y contratos del cambio aceptado pasan a la memoria del proyecto (ya existe el grafo).

### 5.5 Modos de autonomía (`forja.yaml → autonomia`)

| Modo | Qué hace sin preguntar | Dónde se detiene siempre |
|---|---|---|
| `guiado` (por defecto; es el de hoy) | Nada más allá de la fase en curso | En cada puerta |
| `supervisado` | Ejecutar → Validar, dentro del presupuesto | Aprobar plan, **plan de acción de observaciones**, Aceptar, Publicar, preguntas |
| `automatico` | Además, pasa al siguiente sprint de la épica que ya tenga plan aprobado | Plan de acción de observaciones, Aceptar, Publicar, presupuesto agotado, preguntas |

El modo se ve siempre en la barra superior. Cambiarlo es un evento del historial y nunca ocurre solo.
En ningún modo se publica, se ejecuta un plan de acción, se gasta por encima del presupuesto ni se
ejecuta una acción externa sin tu aprobación.

### 5.6 Avisos por correo

Configurable en **Ajustes → Correo (SMTP)** (§6.10). Se avisa cuando:

- El planeador responde en el chat y la respuesta tardó más de un minuto.
- Termina un trabajo (especificar, dividir, validar), bien o con error.
- Termina un run, se detiene o queda esperando algo de ti (pregunta, bloqueo o plan de acción).
- Hay observaciones nuevas listas para revisar.

Cada tipo de aviso se activa o desactiva por separado. El correo lleva el proyecto, qué pasó y el
enlace al panel. Nunca lleva código ni secretos.

---

## 6. La interfaz nueva

### 6.1 Objetivo visual

Pasar de «asistente paso a paso» a **consola de proyecto**: estilo de los bloques de shadcn/ui
(`dashboard-01`, `sidebar-07`), denso pero respirable, con dos niveles (global y proyecto), chat
lateral persistente y todo número clicable. Se conservan Geist, el tema neutral y el modo oscuro, y
se afinan:

- **Tokens**: color de marca (el `brand` actual) más estados semánticos `success`, `warning`,
  `destructive` e `info`, y un color por rol de agente (seis tonos accesibles en claro y oscuro),
  siempre acompañado de icono y texto, nunca sólo color.
- **Tipografía**: Geist Sans y **Geist Mono** para IDs, SHA, rutas y modelos.
- **Movimiento**: `tw-animate-css` para entradas de paneles y cambios de estado; nada de animaciones
  que muevan contenido mientras se lee.
- **Estados comunes**: esqueletos con la forma real, vacíos con acción («Crea tu primer proyecto» con
  ejemplo), errores con qué se conservó y qué hacer, y datos parciales por bloque.

### 6.2 Estructura

```
┌───────────────┬──────────────────────────────────────────────────────────┬─────────────────┐
│ ◆ Forja       │ Proyectos / ERP Winkstec / Cambio «Clientes»   ⌘K  🔔 3  ☾│ Asistente     ⟨ │
│───────────────│ ● en vivo · modo Supervisado · Claude ✓ Codex ⏸ 14:30    │─────────────────│
│ GLOBAL        │──────────────────────────────────────────────────────────│ Contexto:       │
│  Resumen      │                                                          │ [Cambio ▾]      │
│  Proyectos    │                  ÁREA CENTRAL                            │                 │
│ PROYECTO      │                                                          │ burbujas…       │
│  Resumen      │                                                          │                 │
│  Épicas       │                                                          │ ┌─────────────┐ │
│  Requisitos   │                                                          │ │Decisión     │ │
│  Tablero      │                                                          │ │pendiente    │ │
│  Agentes      │                                                          │ │[A] [B] [...]│ │
│  Entregas     │                                                          │ └─────────────┘ │
│  Calidad      │                                                          │ [escribe… @T-3] │
│  Integraciones│                                                          │                 │
│  Documentos   │                                                          │                 │
│  Historial    │                                                          │                 │
│  Actividad    │                                                          │                 │
│  Ajustes      │                                                          │                 │
│───────────────│                                                          │                 │
│ ▣ ERP Winks ▾ │                                                          │                 │
└───────────────┴──────────────────────────────────────────────────────────┴─────────────────┘
```

- **Barra lateral** (componente `Sidebar` de shadcn, colapsable a iconos): grupos Global y Proyecto;
  selector de proyecto al pie. «Avanzado» desaparece: Acciones, Conexiones y MCP pasan a
  **Integraciones**; Auditoría a **Actividad**; Memoria a **Documentos**.
- **Barra superior**: migas de pan, paleta de comandos (⌘K), alertas con contador, tema, estado en
  vivo («Reconectando… última sincronización 14:02»), **modo de autonomía** y **estado de
  proveedores** (cuota pausada hasta tal hora).
- **Panel del asistente**: redimensionable y plegable; en móvil es una vista propia.
- La navegación **conserva filtros y selección** por proyecto (en la URL como `#/p/<id>/tablero?estado=…`),
  así que atrás y adelante funcionan y un enlace se puede compartir entre pestañas.

### 6.3 Pantallas

#### Resumen global *(nuevo)*
- Indicadores clicables: **cambios en curso**, **tareas completadas (periodo)**, **esperan tu
  decisión**, **hallazgos críticos abiertos**, **integraciones verificadas/configuradas** y **consumo
  estimado del periodo**. Cada uno abre la lista filtrada que lo explica.
- Tabla de proyectos: objetivo, etapa, cambio actual, salud, avance verificado, última actividad y
  botón **Continuar: «<siguiente acción>»**.
- Alertas priorizadas de todos los proyectos y una línea de tiempo de la semana.
- Comparaciones con el periodo anterior sólo si hay datos comparables, siempre con la hora de la
  última actualización.

#### Proyectos
- Tarjetas o tabla (conmutables) con búsqueda y filtros. Archivar explica qué pasa con un run activo
  (se detiene ordenadamente antes) y conserva el historial.
- **Nuevo proyecto**: formulario corto (nombre, descripción, tipo, carpeta nueva o importar repo) y
  un ejemplo de descripción. Al crear, abre directamente la conversación de descubrimiento.

#### Resumen del proyecto *(reemplaza a «Inicio»)*
```
┌ Siguiente acción ─────────────────────────────────────────────────────────┐
│ ▶ Revisar y aceptar la entrega de «Clientes» (validada en a1b2c3d)  [Abrir]│
└───────────────────────────────────────────────────────────────────────────┘
┌ Cambio actual ────────────┐┌ Avance ─────────────┐┌ Atención ────────────┐
│ Clientes · Validar        ││ 9/12 tareas unidas  ││ 1 pregunta (T-007)   │
│ ○─○─○─○─●─○─○ fases       ││ plan rev. 2 (+2)    ││ 1 hallazgo alto      │
└───────────────────────────┘└─────────────────────┘└──────────────────────┘
┌ Agentes ahora ────────────────────────┐┌ Entregas recientes ─────────────┐
│ Implementador · T-008 · ejecutando 4m ││ T-006 formulario · unida · diff │
│ QA · escenarios · 3/8                 ││ …                               │
└───────────────────────────────────────┘└─────────────────────────────────┘
```
- El **stepper** de hoy se queda como una franja compacta con las fases nuevas.
- **Avance** = tareas unidas ÷ tareas del plan vigente, mostrando el denominador y la revisión del
  plan. Si el alcance crece, se ve como «+2 por cambio de alcance», no como retroceso.
- «Qué pasó desde tu última visita»: lo que terminó, falló o espera decisión desde la última vez que
  se abrió el proyecto (guardado en el servidor por proyecto).

#### Épicas y sprints *(nuevo)*
- Épicas con su objetivo, criterio de cierre y avance (sprints entregados ÷ sprints de la épica).
- Dentro de cada épica, sus **sprints** (cambios): propuestos, en curso, entregados y publicados,
  cada uno con objetivo, dependencias, estado y fecha **objetivo** (nunca confirmada automáticamente).
  Un sprint vencido se marca «retrasado» sin mover su fecha.
- Crear un sprint desde una idea (queda en `propuesto` con su descubrimiento pendiente), moverlo a
  otra épica y reordenar prioridades. Reordenar respeta dependencias y explica por qué no se puede.
- Las observaciones pospuestas aparecen aquí como candidatas para el siguiente sprint.

#### Historial: lista de control y calendario *(nuevo)*
- **Lista de control** de todo el trabajo del proyecto: épica → sprint → historia → tarea, plegable,
  con una casilla de estado por tarea (✔ unida, ◐ en curso, ○ pendiente, ⚠ bloqueada, ✕ cancelada) y
  avance por cada nivel. Se filtra por épica, sprint, estado, rol y texto.
- **Calendario** mensual y semanal: cada día muestra las tareas que empezaron, se unieron o fallaron, y
  los sprints entregados. Al pulsar un día se ve su lista. Las fechas salen de los eventos: son
  hechos, no planes.
- **Línea de tiempo** por sprint (tipo Gantt simple): cuándo corrió cada tarea y en qué cuenta.
- Exportar la lista de control a Markdown.

#### Requisitos (PRD) *(nuevo; hoy parte de Planeación)*
- Documento por secciones (problema, usuarios, alcance, exclusiones, reglas, flujos, entidades y
  criterios) generado desde `spec.json`, con **índice lateral** y **selector de revisión**.
- **Comparar revisiones** en paralelo o en línea (diff por sección).
- **Pedir un cambio en una sección**: abre el chat con esa sección como contexto y termina en un
  `especificar --cambio` con análisis de impacto (tareas, pruebas y entregas afectadas) **antes** de
  aplicarlo.
- Paneles de **preguntas pendientes**, **supuestos sin confirmar** y **decisiones** (con quién, cuándo
  y qué afecta cada una).

#### Tablero *(reemplaza la lista de «Tareas»)*
```
Pendiente(3)   Lista(2)     En curso(3)      En validación(2)   Completada(9)
┌──────────┐  ┌─────────┐  ┌─────────────┐  ┌──────────────┐    ┌─────────┐
│T-010     │  │T-008    │  │T-004 ● Impl │  │T-003 Revisor │    │T-001 ✓  │
│Búsqueda  │  │API alta │  │haiku · 3m   │  │criterios 2/3 │    │…        │
│⛓ T-004   │  │clientes │  │⚑ 1/2 crit.  │  │              │    │         │
└──────────┘  └─────────┘  └─────────────┘  └──────────────┘    └─────────┘
⚠ Bloqueadas: T-007 espera tu respuesta · T-011 falló 3 veces (tests)       [Ver]
```
- Columnas de §3; **Bloqueadas** como franja transversal con motivo y acción.
- Tarjeta: ID, título, módulo, **rol** con su color, modelo, criterios cubiertos/total,
  dependencias y actividad actual.
- Filtros por rol, módulo, estado y «espera algo de mí»; búsqueda; alternar a vista de **tabla**
  (TanStack Table) y a **grafo de dependencias** con el camino crítico (reutiliza `dependencyLines`
  del tablero de terminal).
- **Sin arrastrar para cambiar de estado**: mover una tarjeta no produce evidencia. Arrastrar sólo
  reordena la prioridad dentro de «Pendiente» y «Lista», y el servidor lo valida.

#### Detalle de tarea *(se amplía el `Sheet` actual)*
Panel lateral ancho, sin perder la posición del tablero. Pestañas:
- **Descripción**: objetivo, criterios (con su veredicto), reglas, archivos que puede escribir y
  dependencias.
- **Ejecución**: intentos como línea de tiempo (intento 1: fallo de calidad en tests; intento 2: …),
  actividad en vivo resumida («Leyendo requisitos», «Ejecutando pruebas»), modelo y consumo.
- **Cambios**: diff con resaltado de sintaxis, árbol de archivos y navegación por archivo.
- **Validación**: pasos (instalar, build, lint, tests, anti-trampas y revisión) con su commit y sus
  hallazgos.
- **Conversación**: preguntas del agente, respuestas y notas del usuario.
- **Historial**: eventos de la tarea.

Acciones contextuales: Pausar, Reanudar, Reintentar con nota, Reasignar y Responder. **Una acción
imposible se muestra deshabilitada con el motivo** («No se puede iniciar: espera a T-004»); el motivo
lo da el servidor.

#### Agentes *(nuevo)*
- Seis tarjetas de rol: estado (activo, inactivo o en pausa por cuota), tarea actual, último
  resultado, tiempo y consumo del run. **Inactivo no es fallo.**
- Al abrir un rol: qué hace (texto fijo), modelos configurados y esfuerzo (con el `ModelPicker`
  existente), ejecuciones recientes con su tasa de aceptación al primer intento (datos del piloto) y
  tareas en cola.
- La actividad se presenta como registro operativo, **no como el razonamiento del modelo**.

#### Entregas *(nuevo)*
- Lista de entregables: diff por tarea, rama de entrega, documentos generados y migraciones, con
  versión (commit), tarea de origen, estado (borrador, en revisión, aceptado o publicado) y fecha.
- **Vista previa** para proyectos web (V3-610): marco con selector de tamaño (móvil, tablet y
  escritorio), commit y hora de generación, con aviso si es anterior a la punta actual.
- **Aceptar entrega / Solicitar ajustes / Publicar** viven aquí (§5.2 y §5.3).

#### Calidad *(nuevo)*
- **Matriz de criterios**: fila por criterio; columnas tarea(s), revisor, QA, auditor y evidencia;
  celdas con `cumple`, `falla`, `bloqueado` o `sin ejecutar` y el commit.
- **Escenarios de QA** con filtros (resultado, módulo y commit), pasos y capturas.
- **Hallazgos** (revisor, auditor y QA) con severidad, clase, estado (abierto, en corrección,
  cerrado o excepción) y tarea de corrección vinculada.
- **Cobertura del auditor**: qué herramientas corrieron y cuáles no.
- Indicadores con **lo que miden** («6 de 8 escenarios ejecutados · 5 pasan»), nunca «el 90 %
  funciona».

#### Integraciones *(une Conexiones, Acciones y MCP)*
- Por conexión: servicio, finalidad, estado (Configurada, Verificada, Degradada o Desconectada),
  última prueba con su alcance, tareas y flujos que dependen de ella, y eventos recientes.
- Probar, rotar credencial (abre la bóveda) y desconectar mostrando lo que queda afectado.
- Acciones propuestas, aprobadas y ejecutadas (lo de hoy), y servidores MCP registrados.

#### Documentos *(nuevo, absorbe Memoria)*
- Los documentos del repo que genera Forja (spec, casos de uso, decisiones, contratos y notas de
  entrega) con búsqueda, versión y enlaces a las tareas que los usan.
- **Memoria**: búsqueda en el grafo y lecciones por aprobar (lo que hoy está en Memoria).
- **Conflictos**: si una instrucción del chat contradice un documento vigente, aparece aquí y en el
  chat para resolverse explícitamente.

#### Actividad *(une Auditoría y eventos)*
- Línea de tiempo filtrable por rol, tarea, tipo (inicio, pausa, fallo, reintento, cambio de alcance,
  aprobación y publicación) y fecha, con enlaces a lo que produjo cada evento. Es de sólo lectura:
  una corrección es un evento nuevo.

#### Ajustes
- Separar **global** (proveedores, sesiones, bóveda, notificaciones, actualización) de **proyecto**
  (roles y esfuerzo, autonomía, paralelismo, presupuesto, perfil, contexto y git).
- Cada ajuste que afecte a un run activo dice **cuándo entra en vigor** («desde el próximo
  lanzamiento»).

### 6.4 Chat contextual

- **Ámbito visible y conmutable**: proyecto, cambio o tarea. Al abrir una tarea el chat propone
  cambiar a su ámbito.
- **Menciones**: `@T-004`, `@CA-012`, `@decision:D-3`. Se enlazan y se pasan como contexto.
- **Adjuntos**: archivos que se guardan en `.forja/adjuntos/<cambio>/` y pasan al planeador como
  referencia (texto) con límite de tamaño.
- **Qué pasó con cada mensaje** (etiqueta bajo la burbuja): «aclaración para T-004 (se le envió)»,
  «propuesta de cambio de alcance (ver impacto)», «pregunta respondida» o «pausa pedida». El servidor
  clasifica cada mensaje con el planeador y el usuario confirma cuando se trata de alcance.
- **Preguntas con opciones**: cuando el planeador pregunta, las alternativas salen como botones (ya
  vienen con `recomendacion`), junto a una respuesta libre.
- Las respuestas enlazan a lo que produjeron (tarea, sección del PRD, hallazgo o decisión).

### 6.5 Alertas y notificaciones

- Fuente única en el servidor que agrupa: pendientes de hoy (preguntas, bloqueos y pausas), pausas
  de proveedor, presupuesto al 80 % y al 100 %, hallazgos bloqueantes, pruebas críticas fallidas,
  conexión degradada y evidencia desactualizada.
- Cada alerta tiene severidad, causa, impacto y acción sugerida. Se agrupan las repetidas. Estados
  **leída** y **resuelta** (resuelta sólo cuando desaparece la causa, nunca al leerla).
- Las notificaciones externas reutilizan `forja notificaciones` (M5), por tipo de evento.

### 6.6 Paleta de comandos (⌘K)

Ir a pantalla, cambiar de proyecto, abrir tarea por ID, «Aprobar plan», «Detener run», «Nueva idea»
y buscar en documentos. Muestra sólo las acciones posibles en ese momento, con el mismo motivo que
los botones.

### 6.7 Tiempo real y conexión

- Se mantiene SSE con cursor (ya recuperable). El indicador de la barra muestra «Reconectando…» con la
  hora de la última sincronización, y al volver se recarga desde el servidor.
- Nada de porcentajes simulados: el progreso sale de tareas y escenarios medidos; los minutos
  restantes se marcan siempre como estimación (ya es así).

### 6.8 Móvil y accesibilidad

- Por debajo de `md`: barra lateral como `Sheet`, tablero como lista agrupada por columna, tablas
  como tarjetas y chat en su propia vista. Debe poderse **ver avance, responder decisiones, aceptar y
  ver entregas** desde el móvil.
- Foco visible, navegación completa por teclado (el tablero incluido), `aria-live` sólo para cambios
  relevantes y sin robar el foco, y estados siempre con texto e icono.

### 6.9 Modo servidor (Doko) con login

Para correr Forja en un servidor como Doko y usarlo desde el navegador:

- **Comando** `forja servidor`: escucha en `0.0.0.0:<PORT>` (por defecto 8080), detrás del proxy
  con TLS de Doko. Exige `FORJA_URL_PUBLICA` (Host y Origin se validan contra ella) y
  `FORJA_DUENO_EMAIL`.
- **Sin sesión no hay nada.** Antes de iniciar sesión sólo responden `/login`, sus propios
  archivos (JS, CSS y fuentes de la pantalla de login, sacados del manifiesto de Vite), la API
  `/v1/auth/*` y `/salud` para el health check. El panel, sus archivos, la API y los eventos
  responden 401 o redirigen a `/login`.
- **Registro como en Winkstec ERP**: la pantalla de registro existe, pero está **cerrada**. Sólo se
  puede registrar el correo `FORJA_DUENO_EMAIL`. Cualquier otro correo recibe «registro cerrado» y
  el intento queda auditado. Sólo el dueño puede iniciar sesión.
- **Verificación del correo** con un código de 6 dígitos: se envía por el SMTP configurado (variables
  `FORJA_SMTP_*` o Ajustes) y, si no hay SMTP, se escribe en el registro del servidor, que sólo ve
  quien administra Doko.
- **Contraseñas** con `scrypt` (de `node:crypto`), bloqueo de 15 minutos tras 5 intentos fallidos,
  límite por IP, sesión en cookie `HttpOnly; Secure; SameSite=Strict` con CSRF (lo de hoy), cierre
  de sesión y cambio de contraseña. Las sesiones se guardan en disco: reiniciar el contenedor no
  cierra la sesión.
- **Imagen**: `Dockerfile` en la raíz con Node, git, bubblewrap y los CLI de Claude y Codex, y datos
  persistentes en `/datos` (`FORJA_HOME`, cuentas y proyectos). Guía en `docs/guias/SERVIDOR.md`.
  El sandbox bwrap no funciona dentro de un contenedor Docker (probado, §12 V3-732): `forja
  doctor` lo marca como error, y para ejecutar agentes hay que instalar en el host.

### 6.10 Correo (SMTP)

En **Ajustes → Correo**, junto a proveedores y modelos:

- Servidor, puerto, seguridad (TLS o STARTTLS), usuario, **clave de aplicación**, remitente y
  destinatario de los avisos.
- Pensado para **Auralis Mail**: en su panel se crea una *clave de aplicación* para la cuenta
  remitente y se pega aquí; sirve igual Gmail (contraseña de aplicación) o cualquier SMTP.
- La clave se guarda **cifrada** en `~/.forja/correo.json` (AES-256-GCM con una clave local `0600`)
  y nunca vuelve al navegador: el panel sólo ve «configurada».
- Botón **Enviar correo de prueba** y casillas por tipo de aviso (§5.6).
- En modo servidor también se puede configurar por variables de entorno `FORJA_SMTP_*`, que mandan
  sobre lo guardado.

### 6.11 Componentes y librerías

Todo se añade con la CLI de shadcn como código propio, igual que hoy. Cada librería se revisa contra
la CSP (sin `innerHTML`; los estilos inline sólo por CSSOM o con el nonce) y lo comprueba
`test/api/server.test.ts`.

| Necesidad | Componente / librería | Nota CSP |
|---|---|---|
| Barra lateral | shadcn `sidebar` | Sin riesgo |
| Paleta ⌘K | shadcn `command` (`cmdk`) | Revisar que no inyecte `<style>` |
| Tablas | shadcn `data-table` + `@tanstack/react-table` | Sin riesgo |
| Gráficos | shadcn `chart` (Recharts) | El `ChartStyle` de shadcn inserta un `<style>`: pasarle el nonce o reescribirlo con variables CSS |
| Paneles redimensionables | shadcn `resizable` | Usa `style` por CSSOM: permitido |
| Migas, avatar, popover, hover-card, badge, breadcrumb, pagination y calendar | shadcn | Sin riesgo |
| Diff con resaltado | `prism-react-renderer` (tokens como elementos React) | **No** usar `shiki`: devuelve HTML |
| Markdown del PRD | `react-markdown` sin `rehype-raw` | Renderiza elementos, no HTML |
| Grafo de dependencias | `@xyflow/react` o SVG propio | Revisar sus estilos; el SVG propio es más seguro |
| Reordenar prioridad | `@dnd-kit` | Transformaciones por CSSOM |
| Rutas | `wouter` o hash router propio | Sin riesgo |

---

## 7. Backend y datos

### 7.1 Entidades y eventos nuevos

Todo sigue siendo por eventos (ADR-006) con proyecciones en SQLite. Nombres en español como el resto.

| Entidad | Campos principales | Eventos |
|---|---|---|
| `cambio` (se amplía) | + `epica_id`, `prioridad`, `fecha_objetivo`, `modulos[]`, `aceptacion`, `publicacion` | `cambio.propuesto`, `cambio.priorizado`, `cambio.validacion_iniciada`, `cambio.aceptado`, `cambio.ajustes_pedidos`, `cambio.publicado` |
| `epica` | nombre, objetivo, criterio de cierre, sprints | `epica.creada`, `epica.editada`, `epica.cerrada` |
| `observacion` | fuente, severidad, clase, ubicación, evidencia, commit, estado, motivo | `observacion.registrada`, `observacion.estado_cambiado` |
| `cuenta` (fuera del almacén: `~/.forja/cuentas.json`) | proveedor, alias, carpeta de sesión, activa, `max_agentes` | — |
| `validacion` (evidencia) | criterio, fuente (revisor/qa/auditor/verificación), resultado de 4 valores, commit, entorno, artefactos | `validacion.registrada`, `validacion.desactualizada` |
| `hallazgo` | fuente, severidad, clase, ubicación, evidencia, condición de cierre, estado, `vinculado_a`, `tarea_correccion` | `hallazgo.abierto`, `hallazgo.vinculado`, `hallazgo.cerrado`, `hallazgo.exceptuado` |
| `escenario` (QA) | caso de uso, pasos, datos, esperado | `escenario.creado`, `escenario.ejecutado` |
| `entregable` | tipo, tarea o cambio de origen, commit, ruta, estado | `entregable.registrado`, `entregable.estado_cambiado` |
| `alerta` (proyección) | severidad, causa, impacto, acción, agrupación, leída, resuelta | derivada de otros eventos + `alerta.leida` |
| `excepcion` | hallazgo, justificación, fecha, alcance (commit) | `excepcion.registrada` |
| `visita` | última apertura del proyecto en el panel | — (tabla simple) |

El dominio de tareas **no** cambia sus estados; se añaden los tipos de tarea `integracion` y
`correccion`, y los campos `rol` y `modulo`.

### 7.2 API (nuevas rutas, mismas reglas: ETag, CSRF e idempotencia)

- `GET /v1/global/resumen` agrega todos los proyectos del registro, sólo lectura.
- `GET /v1/siguiente` devuelve la siguiente acción con su motivo y sus bloqueos.
- `GET /v1/alertas`, `POST /v1/alertas/<id>/leida`.
- `GET /v1/epicas`, `POST /v1/epicas`, `GET /v1/historial` (lista de control y calendario), `POST /v1/cambios` (proponer), `POST /v1/cambios/<id>/prioridad`, `POST /v1/cambios/<id>/activar`.
- `GET /v1/spec/revisiones`, `GET /v1/spec/diff?de=N&a=M`, `POST /v1/spec/cambio` (con impacto previo: `?simular=1`).
- `GET /v1/calidad` (matriz, escenarios, hallazgos y cobertura), `POST /v1/hallazgos/<id>/excepcion`.
- `GET /v1/entregas`, `POST /v1/entrega/aceptar` (exige el commit visto), `POST /v1/entrega/ajustes`, `POST /v1/entrega/publicar`.
- `GET /v1/agentes` (roles, estado y métricas), `GET /v1/actividad?filtros`.
- `GET /v1/preview` (estado, URL y commit), `POST /v1/preview/iniciar|detener`.
- **Motivos de acciones imposibles**: cada recurso incluye `acciones: {nombre: {posible, motivo}}`
  para que el panel no deduzca reglas.

### 7.3 Motor

- **Fase `validar`** en el orquestador como etapa nueva de `run/pipeline/` (`ChangeValidator`), con
  Revisor de cambio, Auditor y QA como lanzamientos del mismo runner y sandbox. Los tres cuentan contra N.
- **Tareas de corrección**: revisión aditiva del plan (no invalida lo unido), con límite de rondas.
- **Auditor determinista**: módulo `src/audit/` con adaptadores por gestor (npm, pip y cargo), escáner de
  secretos del diff y detector de operaciones destructivas; declara lo no cubierto.
- **QA**: `src/qa/` genera escenarios desde la spec (planeador, con salida JSON y plantillas) y los
  ejecuta con el perfil (`test_e2e` nuevo en `perfil.comandos`, o Playwright si hay `preview`).
- **Preview**: comando `preview` en el perfil, lanzado en el sandbox sobre la rama de entrega con un
  puerto local y proxy en `forja ui` (detrás del login en modo servidor), con su proceso supervisado igual que un agente.
- **Siguiente acción y alertas**: funciones puras sobre las proyecciones, con pruebas unitarias.
- **Modos de autonomía**: el motor encadena fases según `autonomia`, y cada salto automático es un
  evento con motivo.
- **Publicar**: `gh pr create` (si `gh` está autenticado) y merge local opcional.

### 7.4 CLI (paridad con el panel)

`forja siguiente`, `forja validar`, `forja aceptar`, `forja ajustes "…"`, `forja publicar [pr|main|accion]`,
`forja epicas`, `forja historial`, `forja cambio nuevo "…"`, `forja calidad`, `forja hallazgos`, `forja agentes`,
`forja preview`. Todos con `--json`.

---

## 8. Fases de entrega y backlog

Cada fase se puede usar al terminar. Orden de implementación en la rama `mejoras/v3`: F0 → F7
(servidor, correo, cuentas, coordinación y observaciones) → F1 → F2 → F5 (historial) → F3 → F4 → F6.

Tamaño S/M/L = incertidumbre relativa. **Riesgo alto** = revisión humana de diseño.

### F0 · Arreglos y base visual

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-001 | Catálogo: añadir `claude-sonnet-5-5`, `codex:gpt-5.6-sol`, `gpt-5.6-terra` y `gpt-5.6-luna` (estado `anterior`), con sus esfuerzos | — | S, bajo | `forja modelos` y el selector los muestran; prueba del catálogo actualizada |
| V3-002 | Tokens de diseño: colores por rol, `info`, Geist Mono, radios y sombras; página interna de muestra | — | S, bajo | Contraste AA en claro y oscuro comprobado |
| V3-003 | Shell nuevo: `Sidebar` de shadcn con grupos Global/Proyecto, migas y barra superior con estado en vivo, modo y proveedores | V3-002 | M, medio | Todas las pantallas actuales siguen accesibles; móvil con `Sheet` |
| V3-004 | Router con estado en la URL (proyecto, pantalla, filtros y selección) | V3-003 | M, medio | Atrás/adelante y recarga conservan la vista |
| V3-005 | Paleta ⌘K con navegación y búsqueda de tareas | V3-004 | S, medio | Prueba CSP en verde |
| V3-006 | Componentes base: estados vacío, error y parcial, esqueletos, `DataTable` y `StatBadge` | V3-002 | S, bajo | Usados por dos pantallas o más |

### F1 · Resumen, siguiente acción, alertas y actividad

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-110 | `siguienteAccion()` pura + `GET /v1/siguiente` + `forja siguiente` | — | M, medio | Pruebas por cada fase y pendiente |
| V3-111 | `acciones: {posible, motivo}` en tarea, plan y run | V3-110 | M, medio | El panel no calcula reglas propias |
| V3-120 | Proyección de alertas con agrupación y leída/resuelta + campana | — | M, medio | Resolver la causa cierra la alerta; leer no |
| V3-130 | Pantalla **Resumen del proyecto** (reemplaza Inicio; el flujo guiado queda dentro de «Cambio actual») | V3-003, V3-110 | L, medio | Muestra siguiente acción, avance con denominador, atención, agentes y entregas |
| V3-131 | «Qué pasó desde tu última visita» | V3-130 | S, bajo | Lista correcta tras cerrar y volver |
| V3-140 | Pantalla **Actividad** (une Auditoría y eventos) con filtros | V3-006 | M, bajo | Cada evento enlaza a su entidad |

### F2 · Tablero, detalle de tarea y agentes

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-200 | Campos `rol` y `modulo` en tareas (planeador y esquema) | — | S, medio | Planes viejos siguen cargando (valor por defecto) |
| V3-201 | **Tablero** por columnas + franja de bloqueadas + filtros + vista tabla | V3-004, V3-200 | L, medio | Columnas según §3; teclado completo |
| V3-202 | Grafo de dependencias con camino crítico en el panel | V3-201 | M, bajo | Coincide con `dependencyLines` |
| V3-203 | Reordenar prioridad dentro de Pendiente y Lista (servidor valida dependencias) | V3-201 | M, medio | Un orden imposible se rechaza con motivo |
| V3-210 | Detalle de tarea con 6 pestañas, intentos como línea de tiempo y estados de ejecución del §3 | V3-111 | L, medio | «Pausa solicitada» se distingue de «pausada» |
| V3-211 | Diff con resaltado y árbol de archivos | V3-210 | M, bajo | Sin `innerHTML` |
| V3-212 | Resumen en lenguaje de producto en la salida del trabajador | — | S, medio | Aparece en la tarjeta y en el detalle |
| V3-220 | Pantalla **Agentes** (6 roles; los nuevos se muestran «sin configurar» hasta F4) | V3-200 | M, bajo | Inactivo no aparece como fallo; métricas del piloto |

### F3 · Requisitos, decisiones y chat contextual

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-300 | Pantalla **Requisitos**: PRD por secciones, índice y selector de revisión | V3-003 | M, bajo | Se ve cualquier revisión anterior |
| V3-301 | Diff entre revisiones de la spec (API + vista) | V3-300 | M, medio | Muestra lo añadido, quitado y cambiado por sección |
| V3-302 | Cambio en una sección con **impacto simulado** antes de aplicar | V3-301 | L, alto | El impacto coincide con lo que después invalida `especificar --cambio` |
| V3-303 | Supuestos sin confirmar y decisiones con lo que afectan | V3-300 | M, medio | Un supuesto sólo desaparece al confirmarlo o rechazarlo |
| V3-310 | Chat lateral persistente con ámbito (proyecto/cambio/tarea) y menciones | V3-003 | L, medio | Mismo historial en el panel y en `forja planear` |
| V3-311 | Clasificación del mensaje y etiqueta de «qué pasó» | V3-310 | M, alto | Un cambio de alcance nunca se aplica sin confirmar |
| V3-312 | Adjuntos al descubrimiento | V3-310 | S, medio | Límite de tamaño; redactados antes de llegar al modelo |
| V3-313 | Preguntas del planeador con opciones como botones | V3-310 | S, bajo | Siempre queda la respuesta libre |
| V3-320 | Pantalla **Documentos** (docs generados, memoria y conflictos) | V3-300 | M, bajo | Búsqueda por texto y enlaces a tareas |

### F4 · Validar y aceptar (los tres roles nuevos)

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-400 | Entidades `validacion`, `hallazgo`, `excepcion` y `escenario` con eventos y proyecciones | — | L, alto | Réplica de eventos equivalente; migración del almacén probada |
| V3-401 | Roles `auditor`, `qa` e `integrador` en `forja.yaml`, catálogo y selector | V3-001 | S, medio | Configs viejas cargan con valores por defecto |
| V3-402 | Clase de hallazgo en el revisor (`defecto`/`sugerencia`/`requisito_nuevo`) | V3-400 | S, medio | Sólo `defecto` rechaza |
| V3-410 | Fase **validar** en el motor (`ChangeValidator`) con límite de rondas | V3-400 | L, alto | Caída a mitad de validar se recupera sin duplicar hallazgos |
| V3-411 | Revisor de cambio y matriz criterio → evidencia | V3-410 | M, medio | Criterio sin cobertura aparece como tal |
| V3-412 | Auditor: herramientas deterministas + revisión por modelo + cobertura | V3-410 | L, alto | Un secreto sembrado en el diff se detecta; lo no cubierto se declara |
| V3-413 | QA: escenarios desde la spec, ejecución y resultados de 4 valores | V3-410 | L, alto | No ejecutado ≠ pasó; evidencia con commit |
| V3-414 | Tareas de corrección vinculadas (revisión aditiva del plan) | V3-410 | M, alto | Lo ya unido no se invalida |
| V3-415 | Vinculación de hallazgos equivalentes | V3-411 | M, medio | Mismo archivo/rango o criterio → uno solo con varias evidencias |
| V3-416 | Evidencia desactualizada cuando la rama avanza | V3-400 | S, medio | Se marca, no se borra |
| V3-420 | **Aceptar entrega / Solicitar ajustes** (motor, API y CLI) | V3-410 | M, alto | Aceptar exige el commit visto; si cambia, se invalida |
| V3-430 | Pantalla **Calidad** (matriz, escenarios, hallazgos y cobertura) | V3-411, V3-412, V3-413 | L, medio | Indicadores dicen qué miden |
| V3-431 | Pantalla **Entregas** con aceptación | V3-420 | M, medio | Distingue borrador, en revisión, aceptado y publicado |
| V3-440 | Rol **Integrador**: tipo `integracion`, contexto de contratos, prueba de contrato obligatoria y conexiones sólo por gateway | V3-401 | L, alto | Una tarea de integración sin prueba de contrato no pasa la verificación |

### F5 · Épicas, sprints, historial y autonomía

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-500 | Épicas: crear, asignar sprints (cambios), prioridad y fecha objetivo | — | L, alto | Un solo sprint activo a la vez; los demás en cola |
| V3-501 | Pantalla **Épicas y sprints** | V3-500 | L, medio | Vencido = «retrasado», la fecha no se mueve |
| V3-502 | Pantalla **Historial**: lista de control épica → sprint → historia → tarea, calendario y línea de tiempo | V3-500 | L, medio | Las fechas salen de los eventos; exporta a Markdown |
| V3-510 | Modos `guiado`/`supervisado`/`automatico` | V3-420, V3-500 | M, alto | Cada salto automático es un evento; nunca publica ni ejecuta un plan de acción solo |
| V3-520 | Propuesta del siguiente sprint con motivo | V3-500 | M, medio | Explica dependencias y prioridad |
| V3-530 | Etapa del proyecto calculada (y editable) | V3-500 | S, bajo | Visible en el resumen global |

### F6 · Preview, publicar y resumen global

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-600 | Resumen **global** multi-proyecto con indicadores clicables | V3-120, V3-130 | M, medio | Cada número abre su lista filtrada |
| V3-610 | Preview: comando `preview` del perfil en sandbox + proxy local + marco con tamaños | — | L, alto | Avisa si es de un commit anterior |
| V3-611 | Capturas de QA con Playwright sobre la preview | V3-610, V3-413 | M, medio | Captura ligada a escenario y commit |
| V3-620 | Publicar: PR con `gh` y merge local opcional | V3-420 | M, alto | Aprobación ligada al commit |
| V3-640 | Pruebas E2E del panel en CI (Playwright con agentes simulados), incluida la de CSP | F2 | M, medio | Flujo completo idea → aceptar en CI |
| V3-641 | Revisión de accesibilidad y móvil de todas las pantallas | F5 | M, bajo | Teclado y lector de pantalla en los flujos principales |

### F7 · Coordinación, observaciones, cuentas, servidor y correo

| ID | Trabajo | Depende | Tamaño, riesgo | Terminado cuando |
|---|---|---|---|---|
| V3-700 | Bitácora del equipo en el contexto de cada agente (en curso, terminadas y dependientes) | — | M, medio | El prompt de una tarea lista a sus hermanas en curso y lo que cambiaron las unidas |
| V3-701 | Herramienta MCP `equipo` en el gateway | V3-700 | M, medio | Un agente la consulta a mitad de tarea |
| V3-702 | Aviso y orden preferente cuando una tarea lee lo que otra escribe | — | M, medio | Advertencia al dividir; el scheduler prefiere el orden seguro |
| V3-703 | Nodos `resultado` en el grafo de memoria | V3-700 | M, medio | El sprint siguiente recibe lo que hizo el anterior |
| V3-704 | Verificar antes de lanzar si una tarea ya está cubierta | — | S, medio | No se gasta un agente en trabajo ya hecho |
| V3-710 | Observaciones persistentes (revisor por tarea, validación del sprint) con estados | V3-400 | M, alto | Se guardan también las de tareas aprobadas |
| V3-711 | Plan de acción propuesto desde observaciones: aprobar, editar, descartar o posponer | V3-710 | L, alto | Nunca se ejecuta sin aprobación explícita |
| V3-720 | Varias cuentas por proveedor: alta, inicio de sesión, activar y desactivar | — | L, alto | Cada cuenta con su carpeta de sesión; la principal sigue funcionando |
| V3-721 | Reparto de lanzamientos por cuenta y pausas de cuota por cuenta | V3-720 | M, alto | Si una cuenta se queda sin cuota, las demás siguen |
| V3-730 | `forja servidor`: login del dueño, registro cerrado, verificación por código y todo protegido | — | L, alto | Sin sesión, ninguna ruta del panel ni de la API responde |
| V3-731 | Dockerfile y guía para Doko | V3-730 | M, medio | La imagen arranca y responde `/salud` |
| V3-740 | SMTP en Ajustes con clave cifrada, prueba y avisos por tipo | — | M, medio | Correo de prueba enviado con Auralis Mail |
| V3-741 | Avisos por correo al terminar chat, trabajos y runs | V3-740 | M, medio | Un trabajo terminado envía el correo una sola vez |

---

## 9. Criterios de aceptación del documento: dónde estamos y quién lo cierra

| # | Criterio (resumido) | Hoy | Lo cierra |
|---|---|---|---|
| 1 | Proyecto con objetivo, retomable tras cerrar | ✅ | — (V3-131 mejora el regreso) |
| 2 | Pregunta que cambia alcance visible hasta resolverse o aceptar supuesto | Parcial | V3-303 |
| 3 | PRD versionado y relacionado con tareas y entregables | Parcial | V3-300, V3-301, V3-431 |
| 4 | Tarea con criterios, responsable y dependencias | ✅ | V3-200 (rol visible) |
| 5 | Dependiente no inicia sin requisito | ✅ | — |
| 6 | Panel con datos reales y detalle clicable | Parcial | V3-130, V3-600 |
| 7 | Distingue ejecución terminada, validada, aceptada y publicada | Parcial | V3-410, V3-420, V3-620 |
| 8 | Seis roles diferenciados y trazables | Parcial (3 de 6) | V3-401, V3-412, V3-413, V3-440 |
| 9 | Fallo accionable que conserva artefactos | ✅ | — |
| 10 | Reintento = intento nuevo sin efectos duplicados | ✅ | — |
| 11 | QA con pasó/falló/bloqueada/no ejecutada | Falta | V3-413 |
| 12 | Evidencias con versión y entorno | Parcial | V3-400, V3-416 |
| 13 | Aprobaciones con actor, fecha, alcance y versión | ✅ | V3-420 la extiende a la entrega |
| 14 | Cambio de alcance con impacto e historial | ✅ en CLI, parcial en panel | V3-302 |
| 15 | Pausar/cancelar con estado efectivo | ✅ en motor, parcial en panel | V3-210 |
| 16 | Credenciales fuera de chat, logs y exportaciones | ✅ | V3-312 (adjuntos) |
| 17 | Permisos en el servidor | ✅ (un usuario) | V3-111 |
| 18 | Desconexión del navegador sin pérdidas ni duplicados | ✅ | — |
| 19 | Bloqueos, decisiones y siguiente paso en escritorio y móvil | Parcial | V3-130, V3-641 |
| 20 | Cierre con resultado verificable y siguiente bloque | Falta | V3-420, V3-520 |

---

## 10. Fuera de alcance (y por qué)

- **Desplegar**: Forja entrega ramas y PR; desplegar no es parte de su trabajo.
- **Porcentajes de seguridad o de «funciona»**: nunca. Sólo cobertura medida.
- **Mostrar el razonamiento del modelo**: sólo actividad operativa.
- **Otras personas con cuenta en Forja**: hay un solo dueño; lo que se multiplica son las cuentas de
  proveedor y los agentes (§4.9).

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| El costo sube con tres roles más por cambio | Auditor y QA corren una vez por cambio, no por tarea; herramientas deterministas primero; presupuesto `por_run_usd` los incluye; se pueden desactivar por proyecto |
| Bucles de corrección | Límite de rondas y detención con decisión |
| La preview abre un servidor del proyecto | Sandbox, proceso supervisado, sin red externa salvo la que permita el perfil |
| Forja expuesto en internet (modo servidor) | Todo detrás del login; registro cerrado; bloqueo por intentos; cookies `Secure`; Host y Origin contra `FORJA_URL_PUBLICA` |
| Varias cuentas mezclan sesiones | Una carpeta por cuenta y sólo su archivo de sesión montado en el sandbox |
| Recharts/cmdk chocan con la CSP | Prueba CSP en CI (V3-640); alternativas en §6.11 |
| Migración del almacén de eventos | Eventos nuevos son aditivos; proyecciones reconstruibles; backup previo (`forja backup`) |
| El panel crece y se vuelve lento | Chunks por pantalla (ya), tablas virtualizadas, ETag/304 (ya) |

## 12. Estado de implementación (2026-09-29, rama `mejoras/v3`)

✅ hecho y probado · ◐ parcial (qué falta) · ○ pendiente.

| ID | Estado | Nota |
|---|---|---|
| V3-001 | ✅ | Sonnet 5.5 y GPT-5.6 Sol, Terra y Luna en el catálogo |
| V3-002 | ◐ | Color por rol (siempre con texto) y fechas en español; falta la página de muestra y comprobar el contraste AA |
| V3-003 | ✅ | Barra lateral de shadcn colapsable, migas, estado en vivo, avisos y modo demo |
| V3-004 | ◐ | La pantalla y la tarea abierta viven en la URL (`#/tablero/T-003`); los filtros todavía no |
| V3-005 | ✅ | Paleta ⌘K: pantallas, acciones posibles y tareas |
| V3-006 | ◐ | Esqueletos y estados vacíos en las pantallas nuevas; falta un `DataTable` común |
| V3-110 | ◐ | `siguiente_accion` calculada en el servidor (`src/run/next-action.ts`); falta `forja siguiente` |
| V3-111 | ○ | Motivos de acciones imposibles desde el servidor |
| V3-120 | ◐ | Campana con pendientes y cuentas en pausa; faltan los estados leída/resuelta |
| V3-130 | ✅ | Resumen del proyecto |
| V3-131 | ○ | «Qué pasó desde tu última visita» |
| V3-140 | ◐ | «Actividad» es la auditoría existente; faltan los filtros por rol y tarea |
| V3-200 | ◐ | El rol sale de la ejecución; falta el campo `modulo` |
| V3-201 | ✅ | Tablero por columnas, franja de detenidas, filtro por rol, búsqueda y vista tabla |
| V3-202, V3-203 | ○ | Grafo de dependencias y reordenar prioridad |
| V3-210 | ◐ | Detalle con resumen, registro, cambios e instrucciones; faltan validación, conversación e historial por pestaña |
| V3-211 | ◐ | Diff con color por línea; faltan resaltado de sintaxis y árbol de archivos |
| V3-212 | ✅ | `RESUMEN:` del trabajador en tarjetas, detalle e historial |
| V3-220 | ✅ | Pantalla Agentes (seis roles y cuentas) |
| V3-300 a V3-303 | ○ | «Requisitos y plan» sigue siendo la pantalla de planeación existente |
| V3-310 a V3-313 | ○ | Chat lateral con ámbito, clasificación, adjuntos y opciones como botones |
| V3-320 | ○ | Documentos (hoy: la pantalla de memoria) |
| V3-400 | ◐ | Observaciones con eventos y proyección; la validación queda como evento con su informe; los escenarios no son entidad propia |
| V3-401, V3-402 | ✅ | Roles integrador, auditor y QA; clase de hallazgo del revisor |
| V3-410 | ◐ | `forja validar` y botón «Validar el sprint»; todavía no es una fase automática tras el run |
| V3-411 | ◐ | QA revisa cada criterio con cuatro resultados; falta la matriz criterio → evidencia en pantalla |
| V3-412 | ✅ | Secretos y operaciones destructivas sin tokens, más la revisión del modelo; la auditoría de dependencias se declara «no cubierta» |
| V3-413 | ✅ | Perfil completo sobre la entrega y criterios con paso, fallo, bloqueado y no ejecutado |
| V3-414 | ✅ | Sustituido por el plan de acción (V3-711): nunca se corrige solo |
| V3-415 | ✅ | Mismo hallazgo (fuente, tarea, lugar y texto) = una sola observación, aunque lo encuentre otro sprint; si reaparece una «resuelta», se reabre |
| V3-416 | ○ | Evidencia desactualizada |
| V3-420, V3-431 | ○ | Aceptar entrega y pantalla Entregas |
| V3-430 | ✅ | Pantalla Calidad |
| V3-440 | ◐ | Las tareas `integracion` van al integrador; falta exigir la prueba de contrato |
| V3-500 | ✅ | Épicas y asignación de sprints con prioridad y fecha objetivo |
| V3-501 | ◐ | Pestaña Épicas dentro de Historial |
| V3-502 | ✅ | Lista de control, calendario y exportar a Markdown |
| V3-510, V3-520, V3-530 | ○ | Modos de autonomía, siguiente sprint propuesto y etapa |
| V3-600, V3-610, V3-611, V3-620, V3-630 | ○ | Resumen global, vista previa, capturas de QA, publicar (PR) y línea de tiempo |
| V3-640 | ○ | E2E del panel en CI (hoy se verificó con Chromium a mano) |
| V3-641 | ◐ | Móvil revisado en Resumen y Tablero |
| V3-700, V3-701, V3-702 | ✅ | Bitácora del equipo, herramienta MCP `equipo` y orden seguro |
| V3-703 | ◐ | «Quién cambió este archivo» sale del almacén de eventos en `pedir_contexto`; faltan los nodos en el grafo |
| V3-704 | ○ | Verificar antes de lanzar |
| V3-710, V3-711 | ✅ | Observaciones y plan de acción aprobado por el usuario |
| V3-720, V3-721 | ✅ | Cuentas múltiples y reparto por cuenta |
| V3-730 | ✅ | `forja servidor` con login del dueño |
| V3-731 | ◐ | La imagen construye y protege todo; los agentes no pueden aislarse dentro de un contenedor (ver V3-732) |
| V3-732 | ○ | **Nuevo:** sandbox de agentes en contenedores. Ni `--privileged` sirve para bubblewrap en Docker. Opciones: instalar en el host con systemd, Docker con el socket y rutas iguales, o gVisor |
| V3-740, V3-741 | ✅ | SMTP con clave cifrada y avisos por tipo |
