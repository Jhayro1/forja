# Riesgos, decisiones pendientes y preparación

## Registro de riesgos

| Riesgo | Señal / impacto | Tratamiento y dueño propuesto |
|---|---|---|
| Aislamiento incompatible con login oficial | Credenciales legibles o CLI inutilizable | Responsable runtime, M0: certificar modo alternativo o limitar a planificación |
| Condiciones de proveedor incompatibles con distribución | Restricciones aplicables al uso concreto | Mantenedor, M0/M4: documentar modo; revisar fuentes vigentes y consultar proveedor si es ambiguo |
| Cambio de protocolo CLI | Versión nueva o resultado desconocido | Adaptadores: matriz por versión/capacidad; fallar cerrado donde afecte éxito/seguridad |
| Resultado remoto perdido | Timeout tras efecto o pago | Runtime/ejecutor: desconocido, conciliación; sin garantía de exactly-once |
| Pérdida del host | Datos y claves locales desaparecen | Operación: backup fuera del mismo disco y simulacro de restauración |
| Especificación equivocada | Todos los tests pasan para un requisito incorrecto | Producto: ejemplos concretos y revisión humana de criterios antes de implementar |
| Agentes alteran veredicto | Tests/scripts/fixtures manipulados | Verificador aislado y controles protegidos |
| Tareas fragmentadas en exceso | Sobrecosto de contexto/merge | Planeador: medir costo por cambio aceptado, reagrupar trabajo |
| Paralelismo empeora tiempo | Lockfile común, CPU/RAM/test saturados | Scheduler: recursos exclusivos y pruebas 1/2/N workers |
| Fuga por almacenamiento del CLI | Transcripción fuera del redactor | Adaptadores: inventario de persistencia y ausencia preventiva de secretos |
| DB bloquea servidor | Consultas/indexación largas | Escritor aislado, lotes acotados, paginación y benchmark |
| Grafo incompleto | Impacto no detectado | Memoria: invalidación conservadora y suite completa |
| Alcance crece sin entrega | UI/conectores antes de circuito seguro | Mantener puertas por hito y release acotado |

## Decisiones recomendadas y abiertas

| Tema | Recomendación de esta revisión | Momento de confirmar |
|---|---|---|
| Plataforma y stack inicial | Linux, un usuario, TS/JS | Antes de M0; si cambia, añadir matriz correspondiente |
| Proveedores del MVP | **Claude y Codex** (decidido por el usuario); uno bloqueado no detiene al otro | V2-005 |
| Mecanismo exacto de sandbox/runner | Backend Linux que demuestre separación de auth y herramientas | V2-003/V2-004; bloquea workers reales |
| Modelos efectivos | Catálogo inicial Claude (fable, opus, sonnet, haiku) y Codex (gpt-6-astra, gpt-6-sol, gpt-6-luna), configurable y verificado | M0 (V2-006) y evaluación M4 |
| Precio/suscripción/API | Respetar modo elegido, informar capacidades y costo observado | M0; sin cobros implícitos por fallback |
| Alcance de UI inicial | **Tablero de terminal detallado en M3** (decidido por el usuario); panel web en M4 | M3/M4 |
| Primer conector externo | DNS en zona de pruebas o servicio simulado equivalente | Antes de M5; producción no forma parte de la prueba |
| Licencia | Mantener intención Apache-2.0; revisar dependencias al implementar | V2-010/M4 |
| Nombre/distribución | Forja provisional; verificar disponibilidad sin reservar ahora | M4 |
| Idiomas | Diseño en español; README público traducible | M4 |
| Telemetría/equipos/extensión | Sin telemetría por defecto; equipos y extensión diferidos | Después de M4 |

## Qué está listo y qué falta demostrar

Listo como diseño: alcance, invariantes, arquitectura, contratos de datos, estados, flujo de aprobación, recuperación, casos de uso, pruebas, fuentes y backlog. Permite empezar por los ensayos de M0 sin inventar el objetivo del producto.

Pendiente de evidencia: compatibilidad real de cada CLI/cuenta/versión, frontera de credenciales, mecanismo Linux del runner, consumo real, límites de recursos y rendimiento. Estos resultados no se pueden obtener sólo leyendo documentación y no se presentan como validados.

## Secuencia para el primer ciclo de desarrollo

1. Leer README v2, diagnóstico, seguridad y contratos de runtime.
2. Registrar plataforma, versiones y modos oficiales en una matriz; no publicar datos sensibles.
3. Ejecutar V2-001 a V2-005 sobre repos y secretos canario desechables, con un presupuesto acordado para llamadas reales.
4. Registrar evidencia, decisiones y cambios a este diseño. Si no hay modo seguro, entregar planificación/simulación mientras se resuelve el bloqueo.
5. Congelar la primera revisión de formatos y comenzar M1 con el proveedor simulado.

Esta entrega no ejecuta esa secuencia: contiene exclusivamente análisis y documentación.
