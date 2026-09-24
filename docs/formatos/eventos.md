# Formato · eventos (`estado.db`)

## Tabla

```sql
CREATE TABLE eventos (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- orden total dentro del proyecto
  id         TEXT NOT NULL UNIQUE,                -- ULID
  ts         TEXT NOT NULL,                       -- ISO-8601 UTC
  tipo       TEXT NOT NULL,                       -- p. ej. 'tarea.lanzada'
  sujeto     TEXT,                                -- p. ej. 'T-014'
  datos      TEXT NOT NULL,                       -- JSON (ya redactado)
  version    INTEGER NOT NULL DEFAULT 1           -- versión del esquema del evento
);
CREATE INDEX eventos_sujeto ON eventos(sujeto, seq);
```

Las proyecciones (`tareas`, `intentos`, `uso`, `fases`, `puertas`, `acciones`) se actualizan
en la **misma transacción** que el evento. `forja estado --reconstruir` las vuelve a calcular.

## Catálogo inicial

| Tipo | Datos principales |
|------|-------------------|
| `proyecto.creado` / `proyecto.importado` / `proyecto.archivado` | nombre, ruta |
| `fase.iniciada` / `fase.terminada` | fase, hash_entradas |
| `planeador.turno` | sesion_id, rol, resumen, preguntas_abiertas |
| `llm.respuesta_guardada` | hash_prompt, ruta_respuesta |
| `spec.validado` / `spec.huecos` | n_uc, huecos[] |
| `puerta.pendiente` / `puerta.aprobada` / `puerta.rechazada` | puerta, resumen |
| `tarea.creada` / `tarea.invalidada` / `tarea.cancelada` | tarea, motivo |
| `tarea.lanzada` | tarea, intento, nivel, proveedor, modelo, pid, inicio_pid, rama, worktree, hash_paquete |
| `tarea.sesion` | tarea, intento, sesion_id |
| `tarea.checkpoint` | tarea, commit |
| `tarea.interrumpida` | tarea, motivo |
| `tarea.proceso_terminado` | tarea, codigo, ok |
| `verificacion.paso` | tarea, paso, ok, salida_recortada |
| `tarea.aprobada` / `tarea.fallida` / `tarea.escalada` / `tarea.bloqueada` | tarea, intento, motivo, nivel_nuevo |
| `tarea.unida` / `merge.revertido` | tarea, commit |
| `pregunta.creada` / `pregunta.respondida` | tarea, texto, respondida_por, decision |
| `uso` | tarea?, fase, proveedor, modelo, nivel, entrada, salida, cache_leida, cache_escrita, costo_eq |
| `proveedor.limitado` / `proveedor.disponible` | proveedor, hasta |
| `accion.propuesta` / `accion.aprobada` / `accion.rechazada` / `accion.ejecutada` / `accion.deshecha` | id, tipo, conexion, vista_previa_ref, resultado |
| `boveda.abierta` / `boveda.cerrada` / `boveda.conexion_creada` / `boveda.conexion_editada` / `boveda.secreto_usado` | nombre (nunca valor), tarea |
| `leccion.creada` / `decision.creada` | id, texto |

## Reglas

- Los eventos **no se modifican ni se borran**.
- `datos` pasa por el redactor antes de escribirse.
- Cambios de formato: `version` + función de migración al leer.
- Copia de seguridad automática diaria de `estado.db` (`VACUUM INTO`) en `~/.forja/proyectos/<id>/copias/`, conservando las últimas 7.
