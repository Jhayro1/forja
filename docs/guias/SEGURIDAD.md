# Seguridad

## Qué protege Forja

| Riesgo | Control |
|---|---|
| Un agente lee tus otros proyectos, claves SSH o el login de otro proveedor | Sandbox bubblewrap: HOME real oculto, sólo su worktree escribible, sólo el archivo de sesión de **su** CLI montado |
| Un agente exfiltra datos por red | Sin red, salvo un proxy que sólo deja pasar la API de su proveedor (y, si la tarea lo pide y el plan lo aprobó, el registro de paquetes) |
| Procesos huérfanos | `--die-with-parent` y grupo de procesos propio: matar el runner mata todo su árbol |
| Secretos en logs o prompts | Redactor en streaming (valores conocidos y sus variantes base64/url, formas típicas de tokens y llaves) |
| El agente «hace trampa» con las pruebas | Pruebas escritas por otra tarea y protegidas; se detectan `.skip`, cero tests, scripts o configuración alterados y archivos fuera de lo permitido |
| Código sin revisar llega a tu rama | Todo se integra en ramas `forja/*`; `main` nunca se toca; revisor independiente por tarea |
| Un modelo o versión de CLI nueva se comporta distinto | `forja conformidad`: sin conformidad aprobada para esa versión, `forja run` no lo usa |
| Ejecutar algo que no aprobaste | La aprobación queda ligada al hash de especificación, plan, perfil y política: cualquier cambio la invalida |

## Secretos, servicios externos y MCP

- **Bóveda** (`~/.forja/boveda`): AES-256-GCM + scrypt, cabecera autenticada, detección de copia vieja
  repuesta, cierre por inactividad. Los agentes nunca reciben secretos: ni en el prompt, ni en el entorno
  (las variables con forma de credencial y las `FORJA_*` se rechazan), ni montados.
- **Acciones externas**: el agente sólo *propone*. Tú apruebas la vista previa exacta (hash) antes de
  que venza; la ejecuta un proceso aparte con entorno vacío, que bloquea destinos internos y no sigue
  redirecciones. Con bubblewrap, ese proceso corre además en un sandbox sin tu HOME y **sin red**:
  su única salida es un túnel que Forja abre sólo al host y puerto de esa acción, con la dirección ya
  resuelta y comprobada (un cambio de DNS no lo desvía). Un resultado incierto nunca se reintenta a
  ciegas; si el servicio permite buscar por clave (`--consulta`), Forja lo comprueba antes de
  pedirte una decisión. «Deshacer» es siempre una propuesta nueva con su propia aprobación.
- **Clave de la bóveda**: guárdala en el llavero del sistema (`forja boveda llavero guardar`) en
  vez de usar `FORJA_BOVEDA_CLAVE`. `forja boveda purgar-copias` borra copias viejas que todavía
  guardan (cifrados) valores rotados o borrados.
- **MCP**: el único servidor MCP del agente es el gateway de Forja; los servidores externos se
  registran con ruta y versión fijas (sin `npx -y`), sólo exponen las herramientas que autorizas y
  corren sin tu HOME y con sólo sus secretos. Si una herramienta declara `outputSchema`, su salida
  estructurada se valida antes de llegar al agente; si no cumple, el agente recibe un error.
- **Conexiones**: nombrarlas en `forja.yaml` no las concede; cada proyecto las vincula explícitamente
  y cualquier edición invalida vínculos y aprobaciones.

## Panel web (`forja ui`)

- Escucha sólo en `127.0.0.1`. No hay acceso remoto ni túneles.
- Se entra con un código de un solo uso que vence en 5 minutos y viaja en el fragmento de la URL
  (`#codigo=…`), que el navegador nunca manda al servidor.
- Cookie `HttpOnly; SameSite=Strict`, token CSRF en cada acción, validación de `Host` (contra DNS
  rebinding) y de `Origin`, sin CORS, CSP estricta y el DOM se construye sin `innerHTML`: un texto
  de un agente no puede inyectar HTML.
- Sólo con `forja ui --boveda` el panel puede ejecutar acciones aprobadas: la bóveda queda abierta
  en ese proceso y se cierra sola tras `--boveda-minutos` sin uso (15 por defecto). Ejecutar exige
  el mismo hash que viste y aprobaste.

## Riesgos que aceptas (D2-21)

- Una herramienta del agente puede leer el login **de su propio CLI** (hace falta para que funcione).
  El peor caso ante una inyección de prompt es el uso de tu suscripción hasta que cierres sesión.
  Mitigaciones: sin red para herramientas, revisión de diffs y redacción.
- `forja run --sin-conformidad` permite modelos sin certificar; queda registrado en el run.
- `FORJA_BOVEDA_CLAVE` es cómodo para scripts, pero otros procesos de tu usuario pueden leerlo.
- `FORJA_SIMULACION` (modo demo) sólo afecta modelos `simulado:*`; nunca reemplaza a Claude o Codex.

## Reportar un problema de seguridad

No abras un issue público: escribe al mantenedor del repositorio con los pasos para reproducirlo.
