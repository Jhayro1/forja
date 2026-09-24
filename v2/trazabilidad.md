# Cobertura y migración desde v1

La v2 reorganiza temas para evitar contradicciones; no es una copia literal con anotaciones. Los 48 archivos originales se conservan. Ninguna ruta de v1 cambia de significado por sobrescritura.

| Documento(s) original(es) | Ubicación v2 | Cambio de criterio |
|---|---|---|
| README; 00-vision; 01-glosario | README; 02-producto-y-alcance | Visión completa conservada, métricas como hipótesis y términos de runtime precisos |
| 02-arquitectura; 08-proyectos | 03-arquitectura | Monolito modular, usuario/checkout, fronteras y backups |
| 03-flujo-fases; 05-generacion-barata | 04-flujo-y-especificacion | Incrementos, revisiones y generación reproducible |
| 04-modelos-y-costos; 11-proveedores | 07-proveedores-y-costos | Capacidades, datos desconocidos y costos separados |
| 06-memoria-grafo | 08-contexto-y-memoria | Contexto simple primero y aristas con confianza |
| 07-persistencia-y-recuperacion | 05-ejecucion-y-recuperacion | Protocolo de runner, incertidumbre y límites de durabilidad |
| 09-boveda-secretos-y-conexiones; 10-seguridad-y-acciones-externas | 06-seguridad-y-conexiones | Ejecutor separado, confinamiento y aprobación por operación |
| 12-verificacion-y-calidad | 09-verificacion-y-evaluaciones | Controles protegidos y evidencia de pruebas por árbol |
| 13-ui; 14-cli | 10-cli-ui-y-api | Interfaz con estado observado, API y SSE definidos |
| 15-roadmap; 16-backlog | 11-roadmap-y-backlog | Simulador/seguridad temprano, dependencias explícitas y salida por hito |
| 17-riesgos-y-preguntas | 12-riesgos-y-listo-para-empezar | Bloqueos separados de decisiones futuras |
| ADR-001…009 | decisiones | Cada ADR tiene continuidad o sustitución indicada |
| UC-01…14 y casos-de-uso/README | casos-de-uso; 02-producto-y-alcance | Misma intención funcional, reglas R01…R12 y CA revisados; UC-15…17 añadidos |
| formatos/spec-json; forja-yaml; tarea | formatos/especificacion-y-configuracion | Integridad referencial, revisiones, perfiles y aprobación |
| formatos/eventos; boveda | formatos/estado-y-protocolos | Eventos reales, outbox, modelo persistente y ejecutor |

## Cobertura funcional por entrega

| Capacidad del proyecto | Casos / implementación prevista |
|---|---|
| Proyectos nuevos/importados | UC-01/08, V2-015/030 |
| Conversación y documentación | UC-02/03, V2-020/021/022 |
| Completar ideas y sugerir mejoras proactivamente | UC-02, capítulo 13 y V2-025/026; desarrolla los prompts de T-021 de v1 |
| Plan y autorización | UC-04/13, V2-023/024/037 |
| Trabajadores y recuperación | UC-05/09/10/16, V2-016/031/032/033/035 |
| Verificación e integración | UC-06/07, V2-034/036/038 |
| Modelos y consumo | UC-14/17, V2-001/002/013/024/040/042 |
| Panel local | UC-14, V2-041 |
| Secretos/MCP/acciones | UC-11/12, V2-050/051/052 |
| Memoria y análisis ampliado | UC-08/09, V2-060/061/062 |
| Respaldo/restauración | UC-15, V2-017 |

## Correcciones con verificación prioritaria

| Hallazgos | Contrato / prueba que los cierra |
|---|---|
| H01/H02/H14/H19 | UC-11/16, matriz negativa de seguridad y V2-003/014/051 |
| H03/H04/H07/H08 | UC-10/15, fronteras de fallo de 05 y V2-004/016/017/035 |
| H05/H09 | UC-05/07, SHA base y CAS, V2-033/036 |
| H06/H17 | UC-04/13, hashes e invalidación, V2-024/037 |
| H10/H11 | UC-17, normalización/reservas y V2-024/035/042 |
| H12 | UC-08/13, cierre transitivo y V2-037/060/061 |
| H13 | UC-06, manifiesto protegido y V2-034 |
| H15 | Proveedor simulado/redactor antes de ejecución, V2-013/014 |
| H16/H22 | UC-03/04, integridad y suficiencia, V2-021/023 |
| H18 | UC-01/15, checkout independiente y snapshot completo, V2-015/017 |
| H20/H21 | Piloto y hitos acotados, V2-042/043 |

## Uso futuro de v1

No convertir ejemplos v1 en configuración ejecutable sin migrarlos. En particular, sus aliases de modelos, formato de evento lanzado, inyección de secretos, criterios absolutos de recuperación y semántica de aprobación quedan sustituidos. Cualquier dato todavía útil se incorpora con revisión y fuente explícita; no existe fusión automática entre versiones.
