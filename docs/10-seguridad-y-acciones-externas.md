# 10 · Seguridad y acciones externas

## Modelo de amenazas (resumen)

| Riesgo | Mitigación |
|--------|-----------|
| Un agente filtra un secreto en su salida o en un commit | Redactor en toda la salida; escaneo de secretos antes de cada commit de tarea (patrones + valores conocidos de la bóveda) |
| Un agente hace algo destructivo en tu máquina (`rm -rf`, `git push --force`) | Trabaja en su worktree; herramientas restringidas por tarea; lista de comandos denegados en la configuración del CLI; nunca push ni merge a `main` |
| Un agente hace un cambio real fuera del repo (DNS, correo, deploy, base de datos) | **Acciones externas**: siempre con vista previa y aprobación humana |
| Inyección de instrucciones desde el código o los datos que lee el agente | El agente no tiene permisos de escritura externa sin aprobación; el orquestador no ejecuta nada que «diga» el texto del modelo |
| La UI local la usa otro usuario o proceso de la máquina | Escucha en `127.0.0.1`; token de sesión en una cookie `HttpOnly`; protección CSRF |
| Alguien lee la bóveda del disco | Cifrado AES-256-GCM, permisos 600, clave en el llavero o fuera del disco |

## Acciones externas

Una **acción externa** es cualquier operación con efecto fuera del repositorio. Nunca
la ejecuta un agente directamente: el agente la **propone**, Forja la **muestra** y tú la
**apruebas**.

```
agente ──propone──► accion.propuesta {tipo, conexión, plan, vista_previa}
                            │
            Forja genera la vista previa real (ej.: diff de registros DNS actuales vs. propuestos)
                            │
            UI / CLI / notificación:  [Aprobar]  [Rechazar]  [Editar]
                            │ aprobada
            Forja ejecuta con la conexión ──► verifica el resultado ──► auditoria.jsonl
                            │
            guarda cómo deshacerla (estado anterior) cuando el tipo lo permite
```

Ejemplos:

| Tipo | Vista previa | Deshacer |
|------|--------------|----------|
| `dns.cambiar` | Tabla antes/después de los registros de la zona | Restaurar los registros guardados |
| `correo.enviar` | Remitente, destinatarios, asunto y cuerpo renderizado | No se puede (se avisa) |
| `db.migrar` | SQL a ejecutar, **copia de seguridad hecha y verificada**, plan de vuelta atrás | Restaurar la copia |
| `deploy` | Rama, commit, destino y comandos | Redeploy del commit anterior |
| `ssh.ejecutar` | Host y comandos exactos | Según el caso (se pide escribirlo) |

Reglas fijas (no configurables):
- Borrar algo externo (registro DNS, base, contenedor, archivo remoto) **siempre** pide
  aprobación, aunque la política diga otra cosa.
- `db.migrar` **no se ofrece** sin una copia de seguridad verificada (existe y pesa lo
  esperado) y un plan de vuelta atrás escrito.
- Las aprobaciones valen para **una** acción concreta, no para un tipo de acción.

## Auditoría

`auditoria.jsonl` (sólo se agrega, nunca se reescribe) registra: uso de cada secreto (qué
tarea y qué proceso, nunca el valor), acciones propuestas, aprobadas, rechazadas y
ejecutadas con su resultado, cambios en la bóveda y aprobaciones de puertas.

## Permisos de los CLI

Cada adaptador lanza el CLI con las herramientas mínimas:
- Claude: `--allowedTools` / `--disallowedTools` por tipo de tarea y modo de permisos no
  interactivo, limitado al worktree.
- Codex: sandbox de escritura limitado al worktree y sin red por defecto; se habilita la
  red sólo si la tarea lo declara.

Los flags exactos se fijan en el spike (T-001) y quedan en
[11-proveedores.md](11-proveedores.md).
