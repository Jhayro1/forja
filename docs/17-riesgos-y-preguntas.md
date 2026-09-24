# 17 · Riesgos y preguntas abiertas

## Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|-----------|
| R1 | Los **términos de uso** de las suscripciones limitan el uso automatizado o en paralelo de los CLI | Media | Alto | Revisarlos en el spike; documentar en el README qué está permitido; soportar API key como alternativa; Forja sólo maneja el CLI oficial de cada usuario con su propia cuenta |
| R2 | Los **límites de uso** de la suscripción frenan el paralelismo | Alta | Medio | Detección de límite, reparto entre proveedores, `paralelo_max` prudente por defecto, estimación de consumo antes de ejecutar |
| R3 | El **formato de salida** de los CLI cambia entre versiones | Media | Medio | Parsers tolerantes, versión mínima comprobada en `doctor`, fixtures por versión, CI que avisa |
| R4 | Los modelos baratos **no alcanzan** para tareas medianas y todo escala | Media | Alto | Tareas más pequeñas (ajuste del planeador), mejores paquetes de contexto, medir la tasa de escalado por tipo de tarea y ajustar el nivel inicial |
| R5 | Conflictos de merge frecuentes entre tareas paralelas | Media | Medio | Archivos disjuntos por ola, contratos primero, cola de merge con tarea de arreglo |
| R6 | Fuga de secretos | Baja | Muy alto | Nunca en el prompt, redactor, escaneo antes de commit, auditoría, tests de 0 fugas en CI |
| R7 | Agentes que «engañan» a los tests | Media | Alto | Tests intocables por la implementación, detección de patrones, revisor |
| R8 | La especificación se queda corta y se descubre tarde | Media | Medio | Checklist de descubrimiento, reglas de completitud, preguntas que suben, cambios de spec con invalidación selectiva |
| R9 | Alcance demasiado grande para lanzar | Alta | Alto | Roadmap por hitos demostrables; M0–M3 ya es útil sin UI |
| R10 | Nombre «forja» ocupado en npm o GitHub | Media | Bajo | Verificar antes de M7; el nombre es provisional |

## Preguntas abiertas

| # | Pregunta | Quién decide | Cuándo |
|---|----------|--------------|-------|
| P1 | Nombre definitivo del proyecto | Tú | Antes de M7 |
| P2 | Nombres exactos de los modelos de Codex para `--model` (sol, Astra, medio, mini) | Spike T-002 | M0 |
| P3 | ¿Adaptador de Claude sobre el CLI o sobre el Claude Agent SDK (TS)? | Spike T-001 | M0 |
| P4 | ¿Cómo se pasan servidores MCP por ejecución a Codex? | Spike T-002 | M0 |
| P5 | ¿Documentación principal en español con traducción, o al revés, para el público open source? | Tú | M7 (propuesta: código y README en inglés, docs en ambos) |
| P6 | Canal de notificaciones por defecto (navegador, ntfy, Telegram, correo) | Tú | M4 |
| P7 | ¿Soporte multiusuario / equipos (varios humanos aprobando)? | Tú | Después del MVP |
| P8 | ¿Se publican estadísticas anónimas de tasa de escalado por modelo para mejorar los valores por defecto? Solo con opt-in | Tú | Después del MVP |
