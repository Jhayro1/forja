# Recuperación

Forja guarda cada decisión como un evento **antes** de actuar, así que casi todo se retoma
con volver a ejecutar el mismo comando.

## Se cortó la luz, se cerró la terminal o mataste `forja run`

```bash
forja estado        # qué quedó hecho y qué no
forja run           # retoma: reconcilia agentes, integraciones y reservas
```

Al arrancar, `forja run`:

- revisa cada lanzamiento: si el agente terminó mientras no estabas, recoge su resultado; si
  murió a mitad, relanza la tarea **sin contarlo como fallo** (su trabajo parcial sigue en el worktree);
- si la integración de una tarea se publicó pero no se registró, lo detecta (la rama ya la
  contiene) y no la fusiona dos veces;
- libera reservas que no llegaron a lanzar nada.

Los agentes corren en procesos propios: si cierras `forja run` con un solo Ctrl-C, los que están
trabajando terminan su tarea y el siguiente `forja run` los recoge. Con dos Ctrl-C sales al instante
y quedan igual en segundo plano.

## «otro proceso de Forja está usando este proyecto»

Hay un `forja run` vivo (lo dice su pid). Míralo con `forja tablero` o deténlo con `forja detener`.
Si el proceso ya no existe, el bloqueo se toma solo: Forja comprueba pid **y** hora de inicio.

## Una tarea quedó bloqueada

```bash
forja tarea T-007             # por qué: intentos, verificación paso a paso, último error
forja logs T-007              # qué hizo el agente
forja reintentar T-007 "usa la función de contratos, no la reimplementes"
forja run
```

## El plan ya no sirve a mitad de camino

```bash
forja detener
forja dividir                 # plan nuevo (vuelve a la fase aprobar)
forja aprobar plan
forja run                     # run nuevo: conserva lo integrado cuya definición no cambió
```

## Copias de seguridad

```bash
forja backup crear                      # base de datos consistente + lanzamientos + ramas forja/*
forja backup listar
forja backup verificar <id>             # tamaños, sha256 e integridad de SQLite
forja backup restaurar <id> --confirmar
```

Restaurar exige una copia verificada, **aparta** el estado actual (no lo borra) y sólo toca ramas
`forja/*`: tu `main` y tus ramas nunca se modifican. Haz una copia antes de actualizar Forja.

## Nada de esto funcionó

Tu trabajo nunca vive sólo en Forja: lo integrado está en la rama `forja/run/<run>/integracion`
y lo entregado en `forja/entrega/<cambio>`. Puedes seguir a mano con Git desde ahí.
