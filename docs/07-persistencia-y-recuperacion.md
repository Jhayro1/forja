# 07 · Persistencia y recuperación

> Requisito: si el CLI o el daemon dejan de correr, por cierre, caída, reinicio del servidor
> o `kill -9`, al volver a levantarlo **todo sigue donde quedó**, sin perder trabajo ni
> repetir lo que ya se pagó.

## Principio: primero se escribe, luego se actúa

Cada cambio es un **evento** que se guarda en `estado.db` (SQLite en modo WAL, dentro de
una transacción) **antes** de tener efecto. El estado actual (tareas, agentes, costos)
es una proyección de esos eventos. Ver [ADR-006](decisiones/ADR-006-estado-por-eventos.md)
y [formatos/eventos.md](formatos/eventos.md).

```
evento "tarea.lanzada" (pid, rama, worktree, sesion_id?)  →  commit  →  spawn del proceso
```

## Qué se guarda y dónde

| Qué | Dónde | Sirve para |
|-----|-------|-----------|
| Eventos del proyecto | `estado.db` | Reconstruir todo el estado |
| Sesión del planeador (id de sesión del CLI y transcripción redactada) | `estado.db` y `sesiones/` | Reanudar la conversación sin reenviar el historial |
| Salida de cada trabajador | `logs/<tarea>/<intento>.jsonl` | Ver qué hizo y retomar |
| Código de cada tarea | rama `forja/T-xxx` en el worktree | El trabajo no se pierde aunque el proceso muera |
| Checkpoints | commits `wip:` en la rama de la tarea | Retomar desde el último punto |
| Decisiones, especificación, tareas | el repo (`.forja/`) | La verdad, versionada |

## Checkpoints de los trabajadores

- Cuando el trabajador termina un turno, y cada N minutos mientras corre, el orquestador
  hace `git add -A && git commit -m "wip(T-014): intento 2, paso 5"` en la rama de la tarea.
- Así, si todo se cae, el código escrito hasta ese momento está en git.
- Al aprobar la tarea, los `wip` se aplastan en un solo commit limpio.

## Al arrancar: reconciliación

```
para cada proyecto con tareas en estado corriendo / verificando / uniendo:
  ¿el PID sigue vivo y es nuestro (comando y hora de inicio coinciden)?
     sí  → volver a vincularse a su salida y seguir
     no  → evento tarea.interrumpida
           ├─ si hay sesion_id y el CLI permite reanudar → reanudar la sesión
           ├─ si no → relanzar el MISMO intento con: paquete + diff actual de la rama
           │          + «continúa; esto es lo que ya hiciste»
           └─ no cuenta como fallo ni sube la escalera
  worktrees sin tarea conocida → se reportan (no se borran)
  tareas "uniendo" → la cola de merge revisa si el merge terminó (git) y continúa
```

Con procesos en marcha:
- `forja parar` → deja de lanzar tareas nuevas, espera a que terminen los turnos en curso,
  hace checkpoint y sale.
- `forja parar --ya` → checkpoint inmediato y termina los procesos (SIGTERM y luego SIGKILL).
- Si el daemon muere, los hijos reciben SIGHUP y terminan. Al volver, la reconciliación
  los relanza desde el checkpoint.

## Retomar el planeador

- La conversación de Descubrir o Especificar se guarda por turnos.
- Al volver: `forja planear` retoma la misma sesión (reanudación del CLI si existe; si
  no, se envía el **resumen acumulado** en lugar de la transcripción completa).
- Las preguntas abiertas y el borrador de `spec.json` se guardan después de cada turno.

## Idempotencia de las fases

- Cada fase registra `fase.iniciada` y `fase.terminada` con el hash de sus entradas.
- Si las entradas no cambiaron y la fase ya terminó, no se repite (sale gratis).
- Las llamadas a LLM se guardan con el hash del prompt: si se repite exactamente una
  llamada que ya terminó (por ejemplo, porque el proceso murió antes de procesar la
  respuesta), se reutiliza la respuesta guardada.

## Servidores (VPS)

- `forja servicio instalar` crea una unidad de systemd de usuario con `Restart=on-failure`.
- La bóveda se desbloquea al arrancar con la clave en el llavero del sistema o con
  `FORJA_CLAVE_MAESTRA` en un archivo de entorno con permisos 600. Ver [09](09-boveda-secretos-y-conexiones.md).

## Criterios de aceptación globales

- Matar el daemon con `kill -9` durante la fase Ejecutar y volver a levantarlo: todas las
  tareas terminan, ninguna se pierde y ninguna se ejecuta dos veces desde cero.
- Apagar el servidor a mitad de una conversación de Descubrir: al volver, la conversación
  sigue con las mismas preguntas abiertas.
- Borrar `memoria.db` y ejecutar `forja memoria reconstruir`: los paquetes de contexto
  vuelven a ser iguales (salvo los pesos aprendidos).

## Copias del estado

Cada día se hace una copia de `estado.db` con `VACUUM INTO` en
`~/.forja/proyectos/<id>/copias/` y se conservan las últimas 7. Si `estado.db` se daña,
se restaura desde ahí (UC-10 E1).
