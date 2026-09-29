# Forja en un servidor (Doko u otra plataforma)

`forja servidor` sirve el panel para usarlo desde el navegador en un servidor, con **login
obligatorio del dueño**. Sin sesión no responde ninguna ruta del panel ni de la API: sólo
`/login` (y sus propios archivos), `/v1/auth/*` y `/salud` para el health check.

## Cómo funciona el acceso

Funciona igual que en Winkstec ERP:

- La pantalla de registro existe, pero está **cerrada**. Sólo se puede registrar el correo de
  `FORJA_DUENO_EMAIL`. Cualquier otro correo recibe «registro cerrado».
- El dueño verifica su correo con un **código de 6 dígitos**. Si hay SMTP configurado, el código
  llega por correo. Si no, se escribe en el registro del contenedor, que sólo ve quien administra
  el servidor.
- Cuando el dueño ya existe, el registro queda cerrado para todos.
- Tras 5 contraseñas incorrectas, la cuenta se bloquea 15 minutos. Además hay límites por IP.
- Las sesiones duran 7 días y sobreviven a un reinicio. En `/datos/forja/servidor/` sólo se
  guarda el hash SHA-256 de cada sesión: leer ese archivo no da una sesión usable.
- «¿La olvidaste?» envía un código para cambiar la contraseña, y cambiarla cierra todas las
  sesiones.

## Variables

| Variable | Obligatoria | Qué es |
|---|---|---|
| `FORJA_URL_PUBLICA` | sí | URL pública exacta, p. ej. `https://forja.winkstec.com`. Host y Origin se validan contra ella |
| `FORJA_DUENO_EMAIL` | sí | El único correo que puede registrarse y entrar |
| `PORT` | no | Puerto interno (8080) |
| `FORJA_SMTP_HOST`, `FORJA_SMTP_PORT`, `FORJA_SMTP_SECURE` (`tls`/`starttls`), `FORJA_SMTP_USER`, `FORJA_SMTP_PASSWORD`, `FORJA_SMTP_FROM`, `FORJA_SMTP_TO` | no | Correo para los códigos y los avisos. También se puede configurar desde Ajustes → Correo |
| `FORJA_CONFIAR_PROXY` | no | `0` para no usar `X-Forwarded-For` en los límites por IP (por defecto se confía en el proxy) |
| `FORJA_SANDBOX` | no | `docker` si el contenedor no permite los namespaces de usuario que necesita bubblewrap |

## Imagen

El `Dockerfile` de la raíz construye el panel y la CLI, instala git, bubblewrap y los CLI de
Claude Code y Codex, y guarda todo lo persistente en `/datos` (monta ahí un volumen):

```bash
docker build -t forja .
docker run -d -p 8080:8080 -v forja-datos:/datos \
  -e FORJA_URL_PUBLICA=https://forja.tudominio.com \
  -e FORJA_DUENO_EMAIL=tu@correo.com forja
```

En Doko: servicio de tipo `web`, Dockerfile `Dockerfile`, puerto `8080`, health check `/salud`,
un volumen en `/datos` y las variables de la tabla (la contraseña SMTP como secreto).

## Correo con Auralis Mail

1. En el panel de Auralis, en la cuenta que va a enviar (p. ej. `noreply@tudominio.com`), crea
   una **clave de aplicación**.
2. En Forja, ve a **Ajustes → Correo**: servidor `mail.tudominio.com`, puerto `587`, STARTTLS,
   usuario la cuenta completa, y la clave de aplicación. Pulsa **Enviar correo de prueba**.
3. Marca qué avisos quieres: chat, trabajos, runs, pendientes y observaciones.

Sirve igual cualquier SMTP; por ejemplo, Gmail con una contraseña de aplicación.

## Límite conocido: los agentes y el sandbox dentro de un contenedor

La imagen sirve el panel, el login, las cuentas, el correo y la planeación. Pero **los agentes
que programan necesitan el sandbox**, y dentro de un contenedor Docker normal bubblewrap no puede
aislarlos.

Se probó el 2026-09-29 en un VPS con Ubuntu 24.04 y Docker 29:

- `bwrap --ro-bind / / --unshare-net true` falla con el contenedor por defecto: sin permisos para
  crear namespaces.
- También falla con `seccomp` y `apparmor` sin confinar, con `--cap-add SYS_ADMIN NET_ADMIN` e
  incluso con `--privileged`. El error es `loopback: Failed RTM_NEWADDR: Operation not permitted`.

`forja doctor` (y **Ajustes → Tu máquina**) lo detecta y lo marca como error. Mientras no esté
resuelto, hay dos caminos:

1. **Instalar Forja directamente en el servidor, sin contenedor**, con `forja servidor` como
   servicio de systemd, y publicarlo con una «puerta» (un nginx sin privilegios) en la
   plataforma. Las plantillas y la explicación están en [`deploy/`](../../deploy/README.md). En
   Ubuntu 24.04, un usuario sin privilegios necesita el perfil de AppArmor para bubblewrap que
   trae esa carpeta.
2. **Usar el contenedor sólo para planear y revisar**, y ejecutar los runs en una máquina con
   sandbox.

Queda pendiente en el plan (V3-732): un sandbox para contenedores. Hay dos opciones:

- `FORJA_SANDBOX=docker` con el socket de Docker y las rutas del volumen iguales dentro y fuera.
- Otro aislamiento, como gVisor.
