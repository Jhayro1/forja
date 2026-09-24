# 08 · Proyectos

Todo está **separado por proyecto**: especificación, tareas, estado, memoria, logs,
worktrees, costos y secretos. Un proyecto nunca ve lo de otro, salvo lo que tú pongas
en el ámbito **global** a propósito (por ejemplo, una conexión de Cloudflare que usan
varios proyectos).

## Registro

`~/.forja/registro.db` guarda por cada proyecto:

| Campo | Ejemplo |
|-------|---------|
| `id` | `prj_01J9…` (ULID; no cambia aunque muevas la carpeta) |
| `nombre` | `mi-bodega` |
| `ruta` | `/root/mi-bodega` |
| `creado`, `ultimo_uso` | fechas |
| `estado` | `activo` / `archivado` |

El `id` también queda en `forja.yaml` del repo. Si mueves la carpeta, `forja proyecto
vincular` actualiza la ruta sin perder el estado.

## Ciclo de vida

```
forja nuevo <nombre> [--ruta]        crea carpeta + git init + forja.yaml + registro
forja importar <ruta>                repo existente → registra y ofrece la fase Analizar
forja proyectos                      lista con estado, fase actual y gasto
forja usar <nombre>                  proyecto activo del CLI (también: el cwd lo decide)
forja proyecto archivar <nombre>     deja de aparecer; NO borra nada
forja proyecto vincular              actualiza la ruta si moviste el repo
```

No existe un comando que borre un proyecto con sus datos. Para borrar, se borra
`~/.forja/proyectos/<id>/` a mano. Es a propósito: nada destructivo con un solo comando.

## Qué proyecto usa cada comando

1. `--proyecto <nombre>` si se pasa.
2. Si no, el repo del directorio actual (busca `forja.yaml` hacia arriba).
3. Si no, el proyecto activo (`forja usar`).
4. Si no, error con la lista de proyectos.

## Aislamiento

| Recurso | Aislado por |
|---------|-------------|
| Estado, memoria, logs, sesiones | carpeta `~/.forja/proyectos/<id>/` |
| Worktrees | carpeta del proyecto y ramas con el prefijo `forja/` |
| Secretos | `boveda.enc` del proyecto + los globales que el proyecto **declara** que usa |
| Paralelismo | `paralelo_max` por proyecto + un tope global de la máquina |
| Presupuestos | por proyecto, más el uso compartido de cada suscripción (global) |

## Varios proyectos a la vez

El daemon puede ejecutar varios proyectos al mismo tiempo. Un **planificador global**
reparte:
- los cupos de procesos (`maquina.paralelo_max`, por CPU y RAM),
- el uso de cada suscripción, que es compartido: si un proyecto consume el límite, el
  resto espera; se puede fijar una prioridad por proyecto.
