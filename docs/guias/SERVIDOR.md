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

## Sandbox en contenedores

Los agentes corren dentro de bubblewrap, que necesita namespaces de usuario. Muchas plataformas
los bloquean dentro de los contenedores. `forja doctor` (o **Ajustes → Tu máquina** en el panel)
dice si funcionan. Si no funcionan hay dos salidas:

- dar al contenedor los permisos que necesita bubblewrap (`seccomp` y `apparmor` sin
  confinar), o
- usar `FORJA_SANDBOX=docker` con el socket de Docker montado.

La segunda salida da mucho poder al contenedor: úsala sólo en un servidor dedicado.
