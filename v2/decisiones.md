# Registro de decisiones v2

Estado común: **recomendadas para implementación** al 2026-09-24; las dependientes de M0 son condicionales. Esta revisión no afirma aprobación del usuario de cada elección ni certificación técnica. Los ADR v1 quedan preservados como antecedente.

| ADR v2 | Decisión y motivación | Alternativa considerada | Consecuencia / condición |
|---|---|---|---|
| D2-01 | Conservar TypeScript/Node 24, modular dentro de un paquete inicial | Go/Rust; monorepo de nueve paquetes | Menos superficie de publicación; patch/API SQLite certificados. Ajusta ADR-001 |
| D2-02 | Scheduler y transiciones deterministas | Un LLM coordina todo; framework como requisito | Control comprobable; juicio sólo al planear/revisar. Conserva ADR-002 sin prometer instantaneidad |
| D2-03 | Adaptadores por capacidades y modos oficiales | Fijar flags/modelos para siempre; extraer tokens | CLI preferido para suscripción cuando sea compatible; SDK/API evaluables por modo, sin fallback facturable implícito. Reemplaza certeza de ADR-003 |
| D2-04 | Spec estructurada, narrativa útil y generación reproducible | Documentos editables como varias fuentes de verdad | JSON autoritativo y diffs de regeneración; revisión por hash. Amplía ADR-004 |
| D2-05 | Memoria simple primero, grafo tras medir | PageRank/utilidad/embeddings desde MVP | Menor complejidad; impacto conservador aunque falten aristas. Escalona ADR-005 |
| D2-06 | Eventos + outbox + runner durable + reconciliación | Persistir evento y suponer spawn atómico | Más protocolo, garantías honestas, estado desconocido. Reemplaza ADR-006 |
| D2-07 | Secretos externos sólo en ejecutor aislado | Entorno del worker y redactor como barrera principal | Mayor trabajo de integración, mejor separación; M5 posterior. Reemplaza ADR-007 |
| D2-08 | Repo para intención/código, DB para historia, índice reconstruible | Todo reconstruible desde repo | Backups abarcan fuentes no reconstruibles. Precisa ADR-008 |
| D2-09 | Mantener intención Apache-2.0 | Otras licencias permisivas | Añadir licencia al implementar; auditar dependencias/publicación, no asumir permisos de proveedores. Mantiene ADR-009 |
| D2-10 | Integrar candidatos verificados con CAS | Merge directo y revert de cada fallo | Evidencia por SHA y recuperación DB/Git, integración sin publicar roto |
| D2-11 | Aprobación de revisión exacta y capacidades | Un booleano global «aprobado» | Invalidación predecible y autorización específica de efectos |
| D2-12 | Costo por cambio aceptado; cuota desconocida permitida | Equiparar token/precio/cuota y escalar al agotar dinero | Métricas honestas, reservas globales y pausa por presupuesto |
| D2-13 | Linux, un usuario y proyectos TS/JS inicialmente (ambos proveedores, ver D2-18) | Todos los SO/lenguajes desde primera versión | Certificación manejable; documentar soporte antes de ampliarlo |
| D2-14 | Verificador separado con controles protegidos | El worker ejecuta sus propios tests y declara éxito | Más costo de materialización, evidencia menos manipulable |
| D2-15 | Un cambio pequeño planificado a la vez | Especificación exhaustiva del producto antes de cualquier código | Admite aprendizaje e invalidación controlada sin renunciar a trazabilidad |
| D2-16 | **Varias tareas en paralelo desde el MVP** (N=3 por defecto, configurable). Decisión del usuario, 2026-09-24 | Ejecución secuencial hasta el piloto M4 | Paralelismo *entre tareas*, distinto de los subagentes que un CLI lanza *dentro* de una tarea. Seguro gracias a I01–I06, recursos exclusivos y desbloqueo al integrar. M4 calibra N |
| D2-17 | **Terminal primero**: tablero interactivo detallado en M3, panel web en M4. Decisión del usuario | Sólo comandos de texto hasta M4 | Misma API/dominio para terminal y web; el tablero funciona por SSH |
| D2-18 | **Claude y Codex en el MVP con todo el catálogo inicial**. Decisión del usuario | Un proveedor certificado primero | M0 certifica ambos; un proveedor bloqueado no bloquea al otro. Reemplaza la parte de D2-03 que admitía un solo proveedor |

## Cuándo revisar estas decisiones

Revisar D2-03/06/07/13 al cerrar M0 y ante cualquier versión que altere aislamiento o autenticación. Revisar D2-05/12 con el experimento M4. Revisar partición modular cuando exista necesidad real de reutilización, no por número de carpetas. Toda sustitución registra contexto, evidencia, alternativa, impacto y migración.
