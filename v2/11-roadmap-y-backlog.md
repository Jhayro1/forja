# Roadmap y backlog de implementación futura

Ninguna tarea de esta lista ha sido implementada. Dependencias nombradas son obligatorias; «paralelizable» describe el futuro scheduler, no autoriza agentes durante esta revisión. Se prioriza un recorrido completo pequeño antes de ampliar catálogo.

## Hitos y puertas

| Hito | Entrega | Puerta para avanzar |
|---|---|---|
| M0 | Evidencia de CLI, login, sandbox, catálogo de modelos y recuperación mínima | **Claude y Codex** satisfacen controles con todos los modelos del catálogo; lo no viable queda documentado con alternativa |
| M1 | Núcleo probado con proveedor simulado | Replay, deduplicación, runner, seguridad y caída sin doble aceptación |
| M2 | Descubrimiento → spec → plan → aprobación por CLI | Plan válido, reproducible y ligado a revisión, sin ejecutar código antes de aprobar |
| M3 | Primer producto usable | Cambio TS/JS completo con tareas dependientes **ejecutadas en paralelo (N=3 por defecto)** con Claude y Codex, tablero de terminal, verificación, recuperación y rama local |
| M4 | Beta pública candidata | Panel web, piloto que calibra N y el enrutamiento, instalación y restauración documentadas |
| M5 | Conexiones y acciones | Una operación tipada en servicio de pruebas con aislamiento, expiración e incertidumbre ensayados |
| M6 | Contexto avanzado | Mejora medida frente al selector simple, sin perder trazabilidad |

Secuencia crítica: M0 → M1 → M2 → M3 → M4. M5/M6 se desarrollan después de una base estable, según beneficio demostrado. M4 puede publicarse sin M5/M6, mostrando funciones ausentes.

## Backlog

Esfuerzo S/M/L expresa incertidumbre relativa, no días. Riesgo alto requiere revisión humana de diseño y pruebas; no se asigna automáticamente al modelo más barato. Cada tarea hereda reglas, contratos y escenarios de los documentos enlazados.

| ID | Hito | Trabajo / artefacto esperado | Depende de | Tamaño, riesgo | Criterio de terminado |
|---|---|---|---|---|---|
| V2-001 | M0 | Matriz Claude, modos oficiales y fixture redactada | — | M, alto | Evidencia de batch, formato, auth, resume, cancelación, uso acumulado y configuración efectiva; ausencias explícitas |
| V2-002 | M0 | Matriz Codex y fixture redactada | — | M, alto | Mismos casos, sesión exacta, sandbox y errores clasificados |
| V2-003 | M0 | Prototipo desechable de aislamiento Linux y autenticación | V2-001, V2-002 | L, alto | Canarios de host/red/credenciales inaccesibles para herramientas; CLI conecta al proveedor; no copiar tokens |
| V2-004 | M0 | Ensayo de runner, spool y muerte en frontera de spawn | V2-003 | L, alto | Identificar proceso y resultado tras caída; no asumir reabrir pipes |
| V2-005 | M0 | ADR de viabilidad y matriz de compatibilidad | V2-004, V2-006 | S, alto | Modo certificado para Claude y para Codex; si uno no pasa, bloquear sólo ese proveedor con alternativa concreta |
| V2-006 | M0 | Catálogo de modelos verificado | V2-001, V2-002 | S, medio | Un `-p`/`exec` mínimo por cada modelo de [07 · Catálogo](07-proveedores-y-costos.md#catálogo-inicial-de-modelos) confirma que la cuenta lo acepta y qué modelo efectivo reporta |
| V2-007 | M0 | Ensayo de paralelismo | V2-003 | S, medio | 3 procesos simultáneos por proveedor en worktrees separados: sin interferencia de sesiones, locks ni cuotas; medir CPU/RAM |
| V2-010 | M1 | Paquete modular TS, licencia y CI | V2-005 | S, medio | Instalar/build/typecheck en Node certificado; CI sin credenciales |
| V2-011 | M1 | Esquemas y dominio: IDs, estados, aprobaciones | V2-010 | M, alto | Ejemplos válidos pasan; referencias rotas, transiciones inválidas y hashes obsoletos se rechazan |
| V2-012 | M1 | DB, eventos, proyecciones, outbox y migraciones | V2-011 | L, alto | Replay equivalente; comando duplicado sin evento/efecto doble; rollback tras fallo de transacción |
| V2-013 | M1 | Proveedor simulado y parsers desde fixtures | V2-011 | M, medio | Error, JSON fragmentado, final ausente, cuota y contadores cubiertos |
| V2-014 | M1 | Redacción, entorno mínimo y política de runtime | V2-003, V2-011 | L, alto | Canarios no llegan a logs/prompt; rechazo de configuración fuera de política |
| V2-015 | M1 | Registro, CLI base, daemon y autenticación local | V2-012, V2-014 | M, alto | Dos clones distinguidos; un dueño por checkout; API rechaza acceso ajeno |
| V2-016 | M1 | Runner supervisado con spool durable | V2-004, V2-012, V2-013, V2-014 | L, alto | Caídas y duplicación de órdenes preservan exclusión y evidencia |
| V2-017 | M1 | Backup/restauración y recuperación de artefactos | V2-015, V2-016 | M, alto | Restaurar snapshot completo y detectar copia incompleta |
| V2-018 | M1 | Adaptadores reales Claude y Codex para planeador/worker/revisor | V2-005, V2-013, V2-014, V2-016 | L, alto | Ambos pasan la misma conformance suite que el simulado; iniciar/cancelar/reanudar según capacidad; smoke controlado con cada modelo del catálogo |
| V2-020 | M2 | Conversación persistente y adaptador planeador | V2-018, V2-015 | M, medio | Turnos y preguntas sobreviven reinicio; entradas redactadas antes del proveedor |
| V2-025 | M2 | Planeador proactivo, prompts y estado de descubrimiento según capítulo 13 | V2-020, V2-011 | M, alto | Idea/mejora, propuestas, cobertura, dudas y decisiones persistidas; prompts versionados; nunca aceptar por silencio |
| V2-026 | M2 | Evaluación conversacional del planeador y puerta de cierre | V2-025 | M, alto | Corpus de 13 pasa controles críticos y revisión humana; resumen aprobado por revisión; sin cuestionario innecesario |
| V2-021 | M2 | Spec, validación semántica y parches por revisión | V2-026, V2-011 | M, alto | Rechazar refs inexistentes y parche obsoleto; conservar decisiones/fuentes del descubrimiento; límites de reparación |
| V2-022 | M2 | Plantillas y manifiesto de generación | V2-021 | M, medio | Generación estable; edición manual produce conflicto visible sin sobrescritura |
| V2-023 | M2 | Descomposición, DAG y recursos compartidos | V2-021 | M, alto | Ciclos, dependencias de pruebas y solapamientos conservadores resueltos |
| V2-024 | M2 | Estimación, reservas y puertas por hash | V2-012, V2-023 | M, alto | Sin run no aprobado; estimar sin modelos; presupuesto desconocido visible |
| V2-030 | M3 | Importación estática, perfil y baseline TS/JS | V2-014, V2-015, V2-024 | M, alto | Importar no ejecuta hooks; baseline usa perfil aprobado y sandbox |
| V2-031 | M3 | Workspaces Git y capturas seguras | V2-016, V2-030 | L, alto | Base exacta, usuario intacto, ninguna captura concurrente o fuera de alcance |
| V2-032 | M3 | Contexto determinista y preguntas estructuradas | V2-021, V2-023, V2-031 | M, medio | Fuentes/hashes guardados; pregunta bloquea sólo alcance afectado |
| V2-033 | M3 | Scheduler paralelo con recursos, reservas y fencing | V2-018, V2-024, V2-031, V2-032, V2-007 | L, alto | N trabajadores simultáneos (defecto 3, `--paralelo`), cupos por proveedor y máquina respetados; tareas independientes no esperan a olas; una dependencia sólo desbloquea tras integrar; sin doble escritor |
| V2-034 | M3 | Verificador y manifiesto protegido | V2-030, V2-031, V2-013 | L, alto | Detectar skip, cero tests, script/config alterada y diferencia fuera de alcance |
| V2-035 | M3 | Reintentos por causa y recuperación end-to-end | V2-033, V2-034, V2-017 | L, alto | Cuota/presupuesto no escalan; recuperación registra costo posible y nuevo lanzamiento |
| V2-036 | M3 | Integrador candidato, CAS y reconciliación Git/DB | V2-033, V2-034 | L, alto | Fallo de suite no mueve ref; caída tras CAS no duplica merge |
| V2-037 | M3 | Cambio de spec e invalidación transitiva | V2-032, V2-033, V2-036 | L, alto | Worker antiguo no integra; tareas unidas generan corrección aprobable |
| V2-039 | M3 | Tablero de terminal (`forja tablero`) y vistas detalladas | V2-015, V2-033 | M, medio | Ver en vivo fases, agentes, logs, diff, contexto, costos y «pendiente de ti»; navegable con teclado; funciona por SSH; mismo dominio que la API |
| V2-038 | M3 | Informe y demo con Claude y Codex en paralelo | V2-035, V2-036, V2-037, V2-039 | M, alto | Incremento completo con tareas de ambos proveedores a la vez, reinicio y evidencia reproducible; rama principal intacta |
| V2-040 | M4 | Conformance continua de proveedores y modelos nuevos | V2-038 | M, alto | Nueva versión de CLI o modelo pasa la matriz antes de habilitarse; sin capacidades fingidas |
| V2-041 | M4 | Panel, API y SSE recuperable | V2-038 | L, medio | Sesión/CSRF/XSS probados, reconexión sin perder estado y costos con procedencia |
| V2-042 | M4 | Piloto de calidad, costo y paralelismo | V2-040, V2-041 | L, medio | Resultados completos del protocolo de 09, incluidos fallos; valor de N por defecto y enrutamiento por modelo calibrados con datos |
| V2-043 | M4 | Empaquetado, guías y revisión de publicación | V2-042 | M, medio | Instalación limpia, nombre verificado, limitaciones publicadas, guía de recuperación y seguridad |
| V2-050 | M5 | Bóveda versionada, rotación y restauración | V2-043 | L, alto | Manipulación detectada; KDF acotada; restauración y cierre ensayados |
| V2-051 | M5 | Ejecutor aislado y acción de referencia | V2-050, V2-014 | L, alto | Preview/hash, autorización, precondición, timeout desconocido e idempotencia cubiertos |
| V2-052 | M5 | Gateway MCP y vistas de conexiones/auditoría | V2-051, V2-041 | L, alto | Worker sin secretos ni herramientas extra; configuración/versiones explícitas |
| V2-060 | M6 | Grafo desde spec y parser TS/JS | V2-043, V2-032 | M, medio | Procedencia, confianza y reconstrucción; limitaciones semánticas visibles |
| V2-061 | M6 | Contexto ampliado y análisis incremental | V2-060 | M, medio | Mismo corpus mejora frente a selección simple sin omitir reglas obligatorias |
| V2-062 | M6 | Más lenguajes y memoria revisada | V2-061 | L, medio | Un lenguaje por matriz de fixtures/perfiles; lecciones no se autopromueven a política |

## Entrega mínima por tarea

Antes de implementar: entradas y hashes, contratos consumidos/producidos, archivos editables/protegidos, tests y recursos exclusivos, riesgo, límite de tiempo y dueño de revisión. Después: diff, comandos ejecutados, resultados, criterios cubiertos y limitaciones. El backlog no autoriza modificar todos los módulos de una fila sin preparar su tarea concreta.

No se convierte automáticamente todo este documento en trabajo para agentes. M0 puede corregir contratos; a partir de su evidencia se congelan formatos y se divide V2-010 en tareas ejecutables. Usar Forja para desarrollarse se permite tras M3 manteniendo una versión estable y una vía manual de recuperación, evitando que la instancia en prueba se supervise a sí misma.
