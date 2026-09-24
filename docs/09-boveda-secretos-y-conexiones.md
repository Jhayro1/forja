# 09 · Bóveda: secretos, variables y conexiones

> Para darle a Forja lo que necesita para trabajar con servicios externos: el token de
> Cloudflare para cambiar DNS, las credenciales SMTP de tu servidor de correo, la URL
> de una base de datos de pruebas, la configuración de un servidor MCP, etc.

## Tres conceptos

| Concepto | Qué es | Ejemplo |
|----------|--------|---------|
| **Variable** | Valor **no** sensible. Se puede mostrar. | `CLOUDFLARE_ZONE_ID=abc123`, `SMTP_HOST=mail.midominio.com` |
| **Secreto** | Valor sensible. Nunca se muestra completo, nunca va al prompt y se redacta de los logs. | `CLOUDFLARE_API_TOKEN`, `SMTP_PASSWORD` |
| **Conexión** | Agrupación con nombre de variables y secretos para **un servicio**, con tipo, permisos y política. | `cloudflare-principal`, `smtp-empresa` |

Y un cuarto que se apoya en los anteriores:

| **Servidor MCP** | Definición de un servidor de herramientas (comando o URL) cuyo entorno sale de conexiones. | `mcp-cloudflare`, `mcp-postgres-pruebas` |

## Ámbitos

- **Global** (`~/.forja/boveda/global.enc`): lo que usan varios proyectos.
- **Proyecto** (`~/.forja/proyectos/<id>/boveda.enc`): sólo ese proyecto.
- Un proyecto usa un secreto global sólo si lo **declara** en `forja.yaml`
  (`conexiones: [cloudflare-principal]`). Nada se hereda por defecto.
- **Nunca** se guardan secretos dentro del repo. `forja.yaml` sólo nombra las conexiones.

## Cifrado

- Archivo cifrado con **AES-256-GCM**. La clave se deriva con **scrypt** de la clave
  maestra, con sal aleatoria por archivo. Todo con `node:crypto`, sin dependencias.
- La clave maestra se obtiene, en este orden:
  1. el **llavero del sistema** (Keychain en macOS, Credential Manager en Windows,
     libsecret en Linux de escritorio), si existe;
  2. la variable `FORJA_CLAVE_MAESTRA`, en servidores, cargada desde un archivo 600 o
     desde el entorno de systemd;
  3. si no, se pide al desbloquear: `forja boveda abrir`, que la mantiene en memoria del
     daemon hasta `forja boveda cerrar` o hasta que pase el tiempo de inactividad.
- Los archivos cifrados tienen permisos 600. El daemon rechaza abrirlos si los permisos
  son más abiertos.
- Se puede exportar e importar la bóveda **cifrada**, para respaldo. Nunca en claro.

## Tipos de conexión (plantillas)

Cada tipo sabe qué campos pide, cuáles son secretos, cómo **probarse** y qué **permisos**
existen. El MVP trae:

| Tipo | Campos | Prueba | Permisos |
|------|--------|--------|----------|
| `cloudflare` | `api_token`🔒, `zone_id`, `account_id` | `GET /user/tokens/verify` | `dns:leer`, `dns:escribir` |
| `smtp` | `host`, `puerto`, `usuario`, `password`🔒, `tls`, `remitente` | conexión + `EHLO` + login, **sin enviar** | `correo:enviar` |
| `postgres` | `url`🔒 | `select 1` | `db:leer`, `db:escribir`, `db:esquema` |
| `ssh` | `host`, `usuario`, `llave_privada`🔒 o `password`🔒 | `ssh -o BatchMode=yes true` | `ssh:ejecutar` |
| `http-api` | `base_url`, `cabeceras`🔒 | `GET` a una ruta configurable | `api:leer`, `api:escribir` |
| `github` | `token`🔒 | `GET /user` | `repo:leer`, `repo:escribir` |
| `generico` | pares clave/valor, cada uno marcado como secreto o no | ninguna | los que declares |

Añadir un tipo es añadir un archivo en `packages/boveda/tipos/` (buena primera
contribución para la comunidad).

## Ejemplos de uso (CLI)

```bash
# Cloudflare (el token se pide oculto; no queda en el historial de la shell)
forja conexion nueva cloudflare-principal --tipo cloudflare --global
#   api_token: ********
#   zone_id: 3f2a...
#   ✔ probada: token válido, zona winkstec.com

# SMTP sólo para un proyecto
forja conexion nueva smtp-empresa --tipo smtp
forja conexion probar smtp-empresa

# Variables sueltas y secretos genéricos
forja var poner LOG_LEVEL=debug
forja secreto poner STRIPE_KEY          # pide el valor oculto
forja secreto importar .env.local       # detecta qué parece secreto y pregunta
forja secretos                          # lista nombres, ámbito, último uso; nunca valores

# Servidor MCP que usa una conexión
forja mcp nuevo cloudflare-dns \
  --comando "npx -y <paquete-del-mcp-de-cloudflare>" \
  --entorno CLOUDFLARE_API_TOKEN=@cloudflare-principal.api_token
```

En la UI existe la misma pantalla: lista de conexiones con estado de la última prueba,
formulario por tipo, botón «Probar», permisos y el historial de uso, sin valores.

## Cómo llegan los secretos a un agente

```
tarea T-031 declara: requiere: [cloudflare-principal:dns:leer]
                         │
      ¿el proyecto declaró esa conexión?  ¿el nivel de la tarea tiene permiso?  ¿la política lo permite?
                         │ sí
   al lanzar el proceso:
     1. entorno del proceso ← SÓLO las variables y secretos de esa conexión
     2. si hay servidores MCP: archivo de config temporal (600) con el entorno resuelto,
        pasado al CLI (--mcp-config en Claude; config equivalente en Codex)
     3. el prompt sólo dice: "tienes la herramienta cloudflare-dns (lectura)"
   al terminar: se borra la config temporal y se registra el uso en auditoria.jsonl
```

Reglas:
- **Nunca en el prompt.** El texto que lee el modelo sólo nombra la herramienta.
- **Mínimo privilegio.** Por defecto un trabajador **no recibe ninguna conexión**. Sólo
  las que su tarea declara y el plan aprobado incluye.
- **Redacción.** Toda la salida de los procesos (stdout, stream-json, logs, UI) pasa por
  un redactor que reemplaza cualquier valor secreto conocido, y sus versiones base64 y
  URL-encoded, por `«secreto:cloudflare-principal.api_token»`.
- **Escritura = acción externa.** Un permiso de escritura (`dns:escribir`,
  `correo:enviar`, `db:escribir`…) sólo se usa mediante el flujo de acciones externas
  con vista previa y aprobación ([10](10-seguridad-y-acciones-externas.md)).
- **Las transcripciones del planeador también se redactan**, por si pegaste un secreto en
  el chat. Además, Forja detecta patrones de tokens en tus mensajes y ofrece guardarlos
  en la bóveda en lugar de enviarlos al modelo.

## Políticas por conexión

```yaml
# se guardan junto a la conexión (cifradas con ella)
politica:
  niveles_permitidos: [planeador, medio]     # quién puede recibirla
  permisos_sin_aprobacion: [dns:leer]
  permisos_con_aprobacion: [dns:escribir]
  expira: 2026-12-31                         # avisa antes de expirar
  solo_ramas: [forja/*]                      # opcional
```

## Criterios de aceptación clave

- `grep` del valor de un secreto sobre `~/.forja/**` (excepto los `.enc`), sobre el repo
  y sobre los logs devuelve **0 coincidencias** después de una ejecución que lo usó.
- Un trabajador cuya tarea no declara la conexión no tiene la variable en su entorno
  (`env` dentro del proceso no la muestra).
- Con la bóveda cerrada, una tarea que requiere una conexión queda `esperando_boveda`
  (no falla y no avanza).
