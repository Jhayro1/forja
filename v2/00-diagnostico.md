# Diagnóstico de la documentación original

Se revisaron los 48 archivos originales: README, 18 capítulos, 9 ADR, 14 casos de uso y su índice, y 5 formatos. No había implementación. Los documentos originales aparecen sin seguimiento en Git; esta revisión no los modifica ni crea commits.

## Lo que conservaría

El orquestador determinista, la separación entre planificar y ejecutar, la especificación versionada, el control humano del alcance, los adaptadores de proveedor, SQLite local, la integración ordenada y la trazabilidad son buenas bases. TypeScript es una elección razonable por familiaridad y ecosistema. No hay evidencia que justifique rehacerlo en otro lenguaje.

Conservaría también el enfoque de contexto por tarea, pero mediría su suficiencia; ahorrar entrada y provocar tres intentos puede salir más caro. La documentación estructurada reduce repetición, aunque producir decisiones claras sigue costando razonamiento.

## Hallazgos y soluciones

P0 bloquea ejecución real; P1 bloquea una beta fiable; P2 mejora posterior. Son conclusiones de diseño derivadas de la revisión, no fallos demostrados en código existente.

| ID | Prioridad | Evidencia en v1 | Problema | Solución v2 |
|---|---|---|---|---|
| H01 | P0 | 09, ADR-007 | Un agente con terminal puede leer sus variables y configuraciones MCP; «fuera del prompt» no significa invisible | Ejecutor de conexiones aislado, credenciales ausentes del agente; límites de esta garantía en 06 |
| H02 | P0 | 10, 08 | Worktree y globs no impiden leer otros proyectos, cambiar metadatos Git o salir por red | Aislamiento del SO, entorno mínimo y políticas comprobadas antes del primer trabajo |
| H03 | P0 | 07, formatos/eventos | `tarea.lanzada` incluye PID antes del spawn; SQLite y procesos no comparten transacción | Intención durable, runner identificado, confirmación posterior y reconciliación |
| H04 | P0 | 07, UC-10 | Reconectar pipes y recibir SIGHUP al morir el daemon no están garantizados | Runner con spool durable, identidad y protocolo de control; no asumir comportamiento de hijos |
| H05 | P0 | UC-05 vs. UC-07 | Una dependencia aprobada puede no estar en la rama desde la que nace la siguiente | Desbloquear al integrar y verificar; registrar el SHA base |
| H06 | P0 | 03, 10, formatos/eventos | Una aprobación no identifica exactamente lo aprobado | Huellas del plan, spec, política y destino, caducidad y revocación |
| H07 | P1 | 07, ADR-006 | «Nada se pierde» y «no se paga dos veces» exceden lo que puede garantizarse | Definir RPO, datos confirmados, resultados desconocidos y reanudaciones facturables |
| H08 | P1 | 07 | `git add -A` mientras el agente escribe puede capturar archivos incompletos o secretos | Detener escrituras, inspeccionar y capturar sólo cambios permitidos; nunca commit concurrente |
| H09 | P1 | 12, UC-07 | Lockfiles e imports no son conflictos trivialmente resolubles | Conflicto como trabajo explícito; regeneración sólo con receta confiable y validación completa |
| H10 | P1 | 04, UC-05 | Agotar presupuesto cuenta como fallo y puede escalar a un modelo más caro | Pausar por presupuesto; separar fallos de código, infraestructura, permisos y cuota |
| H11 | P1 | 04, 13 | Tokens no revelan cuota restante ni factura exacta; resume no es gratis | Contadores desconocidos explícitos, estimación etiquetada y contabilidad por semántica del proveedor |
| H12 | P1 | 06, UC-13 | Tree-sitter no resuelve por sí solo un grafo semántico completo; invalidación selectiva puede omitir dependientes | Aristas con procedencia/confianza y cierre transitivo conservador |
| H13 | P1 | 12 | Proteger sólo el archivo del test deja modificar scripts, fixtures y configuración que lo desactivan | Verificador independiente y manifiesto completo de pruebas protegido |
| H14 | P1 | 03, UC-08 | «Analizar» ejecuta comandos del repo antes de establecer confianza | Inspección estática primero; baseline dinámico sólo en entorno autorizado |
| H15 | P1 | 15, 16 | Redactor y simulador llegan después de sus primeros consumidores | Llevar ambos al núcleo, antes de prompts reales y workers |
| H16 | P1 | formatos/spec-json | Ejemplo refiere R-02 y E-2 inexistentes; alcance de CA ambiguo | Integridad referencial total, IDs globales y formatos v2 normativos |
| H17 | P1 | UC-13 | Un cambio sólo textual puede modificar una regla de negocio | Clasificar por campo semántico, no por tamaño o apariencia del diff |
| H18 | P1 | 07, 08 | Registro por ID del repo mezcla clones locales y se confunde backup con continuidad | Separar proyecto lógico y checkout; backup coherente de DB, refs y artefactos |
| H19 | P1 | 09, 10 | Tamaño de backup no demuestra restaurabilidad; redacción no cubre transcripciones propias del CLI | Ensayo de restauración y diagnóstico de persistencia externa al daemon |
| H20 | P2 | 00, ADR-001/002/005 | Ahorros, aceleración, costo de otros lenguajes y limitaciones de competidores sin medición | Hipótesis comparables; eliminar afirmaciones de superioridad sin experimento |
| H21 | P2 | 02, 15 | Nueve paquetes, varios lenguajes, bóveda y grafo avanzados amplían demasiado el MVP | Monolito modular y entregas verticales, sin eliminar capacidades del plan completo |
| H22 | P1 | 05, UC-03 | Exigir excepción inventada y generar tareas por cada entidad sobreproduce documentación/trabajo | Excepción no aplicable justificada; tareas por incremento verificable |

## Qué cambiaría primero

Primero probaría una tarea aislada: ejecutar, capturar resultado, matar procesos en distintos puntos, recuperar, verificar y materializar un commit. Luego añadiría planificación y un DAG pequeño. UI, relevancia aprendida y conectores de producción tienen valor cuando ese circuito funciona.

El riesgo principal no es elegir un modelo barato equivocado: es que el sistema marque como seguro, recuperado o terminado un trabajo para el que no tiene evidencia suficiente.
