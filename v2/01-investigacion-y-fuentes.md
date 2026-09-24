# Investigación y fuentes

Consulta: 2026-09-24. Fuentes primarias abiertas y leídas; las páginas vivas pueden cambiar. La documentación establece capacidades publicadas, no certifica la versión instalada ni las condiciones particulares de una cuenta. No se ejecutaron CLI de modelos, instalaciones ni benchmarks.

## Cómo se aborda actualmente este problema

| Fuente | Hecho documentado | Aplicación propuesta para Forja |
|---|---|---|
| [S01 · OpenSpec](https://github.com/Fission-AI/OpenSpec) | Desarrollo guiado por artefactos, propuestas, diseño, tareas y cambios sobre proyectos existentes | Trabajar por cambios aprobados, no exigir descubrir todo el producto de una vez. Explorar importación futura; no afirmar que sólo ejecuta en serie |
| [S02 · GitHub Spec Kit](https://github.com/github/spec-kit) | Procesos estructurados, plantillas y resultados documentados para agentes; especificación, reparación y evaluación de ideas | Separar requisito, plan, tarea y evidencia. Forja debe aportar ejecución verificable, no competir sólo en plantillas |
| [S03 · Codex no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode) | `codex exec`, JSONL, salida con esquema, sandbox y reanudación por ID; puede reutilizar autenticación del CLI | Adaptador con capacidades y fixtures. Probar cada combinación de versión, login y política |
| [S04 · Seguridad de Codex](https://learn.chatgpt.com/docs/security) | Distingue sandbox y permisos de aprobación | Modelar confinamiento y aprobación como controles separados |
| [S05 · Claude programático](https://code.claude.com/docs/en/headless) | `-p`, salida JSON/stream y esquemas; `--bare` omite configuración automática y requiere autenticación distinta de login por suscripción. Los costos al reanudar pueden ser acumulados | No activar bare para suscripción por suposición; auditar configuración efectiva y normalizar contadores |
| [S06 · Sandbox Claude](https://code.claude.com/docs/en/sandboxing) | Aislamiento de archivos/red aplicado por el SO para herramientas de shell; depende de plataforma y configuración | Evaluar cobertura real de todas las herramientas, no confundir lista permitida con confinamiento |
| [S07 · Condiciones Claude](https://code.claude.com/docs/en/legal-and-compliance) | Diferencia uso de CLI oficial por su usuario, integración en productos, API y prohibiciones de intermediar credenciales | Mantener binario sin modificar, login oficial del usuario y revisión del modo distribuido antes de publicarlo |
| [S08 · Persistencia LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence) | Distingue checkpoints de un hilo y memoria persistente entre hilos | Separar ejecución recuperable, conversación y conocimiento del proyecto |
| [S09 · Actividades Temporal](https://docs.temporal.io/activity-definition) | Recomienda actividades idempotentes para evitar efectos duplicados al reintentar | Usar intención, claves de idempotencia y reconciliación; no incorporar Temporal al MVP |
| [S10 · Git worktree](https://git-scm.com/docs/git-worktree) | Varios árboles de trabajo asociados a un repositorio, con parte de los metadatos compartidos | Integrador como único escritor de refs; worktree no equivale a frontera de seguridad |
| [S11 · SQLite WAL](https://sqlite.org/wal.html) | WAL tiene restricciones de concurrencia y requiere procesos en la misma máquina; configuración de sincronización afecta durabilidad | DB en disco local, un escritor, transacciones cortas, backups consistentes y pruebas de caída |
| [S12 · SQLite en Node 24](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) | API SQLite integrada, con operaciones de `DatabaseSync` | Conservar Node 24 como base propuesta; aislar acceso pesado para no bloquear el loop del servidor y fijar patch probado |
| [S13 · Tree-sitter](https://tree-sitter.github.io/tree-sitter/) | Parser incremental que construye árboles sintácticos | Extraer sintaxis con procedencia; resolución de símbolos y llamadas necesita análisis adicional |
| [S14 · Seguridad MCP](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) | Describe riesgos de autorización, manejo de tokens y servidores/herramientas | Tratar herramientas MCP como una superficie de permisos y datos no confiables |
| [S15 · Autenticación Codex](https://learn.chatgpt.com/docs/auth) | Documenta autenticación de Codex por cuenta y por API | Declarar modo real de autenticación, sin extraer ni redistribuir tokens |

## Conclusiones de la revisión

**Recomendación propia:** mantener un núcleo determinista y adaptadores pequeños. No se necesita un framework de agentes para ordenar tareas, y añadir uno no elimina los problemas de procesos, Git o permisos. Si mantener ese núcleo resulta demasiado costoso tras las pruebas, reevaluar un motor durable con requisitos concretos.

**Recomendación propia:** la especificación debe evolucionar por incrementos. «Pensar una sola vez» es una aspiración de eficiencia, no una garantía realista. El costo del retrabajo, las revisiones y la integración pertenece a la medición desde el comienzo.

**Límite de la investigación:** soporte técnico de `exec` o `-p` no demuestra uso ilimitado, equivalencia económica entre suscripción y API, ni autorización para cualquier producto comercial. La certificación futura guardará versión, cuenta/modo, configuración efectiva, fecha, pruebas y enlaces aplicables. No se concluye una autorización jurídica general.

Actualización 2026-09-24: los nombres ya no son ejemplos. En este servidor, `claude --help` acepta los alias `fable`, `opus` y `sonnet` (y nombres completos), y el catálogo local de Codex (`~/.codex/models_cache.json`, codex-cli 0.156.1) lista `gpt-6-astra`, `gpt-6-sol` y `gpt-6-luna`. Ver [07 · Catálogo](07-proveedores-y-costos.md#catálogo-inicial-de-modelos). Siguen siendo configuración: M0 (V2-006) confirma que la cuenta acepta cada uno y qué modelo efectivo reporta. Tampoco se trasladan números de versión del servidor original como requisito probado.
