# Verificación, calidad y evaluación

## Evidencia de una tarea

Cadena mínima: requisito → criterio → prueba/evidencia → tarea → árbol/commit → resultado → integración. Un revisor LLM ayuda a detectar problemas, pero no convierte tests incompletos en especificación correcta.

Baseline sobre base limpia y perfil autorizado antes del run. Registrar fallos preexistentes; permitir una excepción sólo con criterio, evidencia, responsable y aprobación explícita. No atribuir al agente un entorno roto ni declarar verde una suite vacía.

## Pipeline

1. Confirmar ausencia de escritores y revisión/aprobación vigente.
2. Capturar diff completo: tracked, nuevos, borrados, renombres, modos y enlaces. Comparar con allowlist y controles protegidos. Violación conserva evidencia y bloquea exportación; no revertir silenciosamente archivos del usuario.
3. Escanear secretos y contenido prohibido antes de cualquier commit/exportación.
4. Materializar árbol candidato en workspace limpio, sin archivos ignorados heredados que alteren pruebas.
5. Ejecutar build/typecheck, lint y tests con comandos resueltos por perfil confiable, timeout, recursos y entorno reproducible.
6. Comprobar que se descubrió y ejecutó cada prueba obligatoria: ausencia, skip, todo, aserciones eliminadas o filtros alterados no son éxito.
7. Revisión de diff contra criterios, contratos y riesgo; para asuntos críticos exigir evidencia especializada o revisión humana explícita.
8. Guardar informe con hashes y elegibilidad para integración. Sobre el candidato integrado ejecutar suite completa en el MVP.

El manifiesto protegido incluye tests de aceptación, fixtures, configuración del runner, scripts de verificación, umbrales, lockfile y herramientas que determinan el veredicto. Cambiarlos puede ser legítimo, pero requiere una tarea de infraestructura/pruebas independiente y nueva revisión. No congelar todas las dependencias para siempre.

## Tests primero sin engañarse

Contratos → prueba real que falla por funcionalidad ausente → implementación → verde. Rojo por import inexistente o configuración rota no demuestra que la prueba capture el requisito: registrar causa y hacer revisión de la prueba. Para cada criterio, al menos un escenario observable; riesgos altos añaden límites, errores y concurrencia.

No imponer TDD artificial a toda investigación o documentación. Esas tareas declaran evidencia apropiada. Un cambio manual tampoco omite pipeline: se acepta el diff humano y se verifica igual.

## Plan de pruebas del propio Forja

La planificación también tiene criterios de calidad: evaluar descubrimiento de huecos, recomendaciones, continuidad de decisiones y cierre sin aceptación inventada. El [corpus conversacional y las reglas de evaluación](13-planeador-proactivo-y-prompts.md) se implementan en V2-026 antes de habilitar el paso de descubrimiento a spec. Las fixtures comprueban el protocolo; la calidad conversacional requiere además pruebas con el perfil real certificado y revisión humana.

| Grupo | Escenarios mínimos | Resultado exigido |
|---|---|---|
| Estado | Transiciones inválidas, replay, comandos duplicados, dos schedulers, reloj alterado | Proyecciones coherentes, sin doble aceptación |
| Proveedor simulado | JSON partido, líneas enormes, stderr, eventos repetidos, exit sin resultado, cuota, uso acumulado, modelo rechazado | Clasificación explícita; sin éxito falso ni suma duplicada |
| Git | Base avanzada, conflicto, lockfile, archivo nuevo/ignorado, rename, branch ausente, repo sucio, clone duplicado | Sin modificar trabajo ajeno; evidencia ligada al árbol correcto |
| Fallos de proceso | Caída antes/después de intención, spawn, confirmación, salida final, actualización de ref y evento de merge | Recuperación idempotente o bloqueo diagnosticado |
| Aislamiento | Lectura fuera, symlink, escritura Git, red, acceso a DB/bóveda, comandos de instalación maliciosos | Denegación efectiva, no sólo un mensaje del prompt |
| Presupuesto | Dos tareas reservan saldo, tokens ausentes, recuperación facturable, parada tardía | Reservas coherentes y consumo desconocido visible |
| Calidad | `.skip`, zero tests, script que devuelve 0, runner cambiado, mocks sustituyen SUT | Verificación rechazada |
| UI/API | Sesión ausente, CSRF, Host malicioso, XSS de logs, SSE duplicado/desconectado | Sin mutaciones no autorizadas ni huecos silenciosos |
| Acciones futuras | Preview caducada, payload alterado, respuesta perdida, operación parcial, doble aprobación | No repetición ciega y conciliación |
| Backup | Restaurar DB + objetos + artefactos; copia incompleta y hash incorrecto | Restauración comprobable o rechazo con diagnóstico |

Tests de integración usan Git/procesos temporales y proveedor simulado desde M1. Pruebas reales con CLI requieren usuario/cuenta y presupuesto específicos; nunca secretos productivos. Caída por `kill -9` no sustituye ensayo de apagado o pérdida de disco en VM desechable.

## Experimento de viabilidad económica

Corpus inicial propuesto: 12 cambios fijos (4 simples, 4 con varios módulos, 4 de integración/errores), repos/SHAs y criterios independientes. Comparar: A, modelo de alta capacidad en serie; B, enrutamiento mixto en serie; C, mismo enrutamiento con N workers (2, 3 y 4). Tres repeticiones por condición, orden alternado y mismas pruebas. Es un piloto, no una estimación estadística definitiva.

Registrar versión/modelo efectivo, caché, fallos, abandonos, costo equivalente cuando exista tarifa, duración, intervención humana y defectos posteriores. La unidad de comparación es cambio **aceptado**; incluir intentos fallidos y reparaciones. Reportar dispersión y casos sin datos, no sólo promedios favorables.

El paralelismo está activo desde M3 (N=3); el piloto ajusta el N por defecto: subirlo si baja el tiempo sin degradar calidad ni disparar conflictos/recursos, bajarlo si no. Habilitar grafo avanzado si supera búsqueda simple con los mismos casos. Si el ahorro no se demuestra, presentar el beneficio de control y trazabilidad sin publicidad de porcentajes.
