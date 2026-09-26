# ADR-012 · Aislamiento con Docker como segundo backend

**Estado:** aceptado para Linux · Windows/macOS nativo sigue pendiente · 2026-09-26

## Contexto

bubblewrap es el único backend de sandbox real hasta ahora, y sólo existe en Linux. Esto deja
dos problemas: (1) en Linux, hay máquinas donde bwrap no sirve (AppArmor bloqueando *user
namespaces* en Ubuntu 24.04+, ya avisado en [INSTALAR.md](../guias/INSTALAR.md)); (2) en
Windows y macOS no hay ningún backend real, sólo prototipos sin probar
([ADR-010](ADR-010-aislamiento-macos.md) para Seatbelt, [ADR-011](ADR-011-aislamiento-windows.md)
para un helper nativo de Windows).

Se evaluó Docker como backend alternativo porque ya soluciona exactamente este problema en
miles de herramientas: Docker Desktop da contenedores Linux idénticos en Windows, macOS y
Linux, sin inventar nada nuevo.

## Lo que se probó de verdad (no es teoría)

Con `dockerd` corriendo, se comprobó a mano, uno por uno, cada garantía que bwrap ofrece:

| Garantía | Cómo se probó | Resultado |
|---|---|---|
| Ejecutar los binarios reales del host (`claude`, `node`) sin reinstalarlos | `docker run -v /opt/claude-code:...:ro -v /opt/node22:...:ro forja-sandbox claude --version` | Corrió igual que en el host |
| Sin red salvo el proxy | `docker run --network none` + intento de resolver DNS | Bloqueado |
| Socket del proxy visible pese a `--network none` | Bind-mount de un socket unix real, conectar y recibir eco desde dentro | Funcionó |
| HOME falso con permisos del usuario | `--tmpfs ruta:rw,exec,uid=X,gid=X` | Escribible, con el dueño correcto |
| Todo lo demás de sólo lectura | `--read-only` en la raíz del contenedor + tmpfs sólo donde hace falta | Escritura fuera de lo declarado, bloqueada |
| El workspace de sólo lectura no se puede escribir | `-v workspace:workspace:ro` | Bloqueado |

Esto quedó como pruebas reales del runner completo (`test/runtime/runner.test.ts`, bloque
`runner con docker`), no sólo del generador de argumentos: lanzamientos de verdad, con
`docker` de verdad, verificando las tres propiedades de aislamiento y el filtro de red por
allowlist — la misma rigurosidad que ya tenían los tests de bwrap.

## Decisión

`src/runtime/docker-sandbox.ts` (`dockerArgs`) es un backend real, no un prototipo: se conectó
en `src/runtime/runner.ts` como una tercera opción de `LaunchOrder.sandbox.mode` (junto a
`bwrap` y `ninguno`), seleccionable con `src/runtime/sandbox-mode.ts`
(`activeSandboxMode()`), y `forja doctor` lo detecta y prepara la imagen
(`docker/sandbox.Dockerfile`, mínima: sólo `debian:bookworm-slim`, porque todo lo demás se
bind-montea desde el host) cuando bwrap no está disponible.

**A diferencia de Seatbelt y del prototipo de Windows, sí queda conectado**, porque sí se pudo
probar: hoy mismo, en Linux, cualquier máquina con bwrap roto (o sin él) puede usar Docker en
su lugar sin perder ninguna garantía de aislamiento.

## Lo que NO queda resuelto (a propósito, no por descuido)

**Windows y macOS nativos siguen sin soporte real**, aunque `activeSandboxMode()` devuelva
`'docker'` para esos `process.platform`: bind-montear el `claude`/`node` del host sólo
funciona porque host y contenedor comparten el mismo sistema operativo (Linux). Un binario
Windows (`.exe`) o macOS (Mach-O) bind-montado dentro de un contenedor Docker —que siempre
corre Linux, incluso vía Docker Desktop— simplemente no ejecuta: no es un problema de
versión de libc como con Linux, es un sistema operativo distinto. `package.json` sigue
declarando `"os": ["linux"]` a propósito: abrirlo ahora dejaría instalar Forja en Windows/macOS
para que fallara en el primer lanzamiento real.

Para que Windows/macOS nativo funcione de verdad con este mismo backend, hace falta una
variante de la imagen que traiga Node y los CLI de los proveedores instalados **dentro** de la
imagen (no bind-montados desde el host), porque ahí no hay binarios de host reutilizables.
Eso choca con el sistema de «conformidad» del proyecto (certifica la versión exacta de CLI que
el usuario tiene instalada y con la que inició sesión): habría que decidir cómo mantener esa
imagen alineada con la versión certificada, y no se ha diseñado ni probado. Sigue quedando
WSL2 como la única vía real para Windows.

## Para ampliarla a Windows/macOS nativo (pendiente)

1. Decidir cómo la imagen Docker para hosts no-Linux instala y actualiza `@anthropic-ai/claude-code`
   y `@openai/codex` sin romper la certificación de «conformidad».
2. Que `activeSandboxMode()` además decida, cuando el modo es `docker`, si los binarios se
   bind-montean (host Linux) o vienen de la imagen (host no-Linux) — hoy `adapters.ts` siempre
   asume la primera opción.
3. Probarlo en una máquina Windows y una Mac reales — nada de esto se puede validar desde un
   contenedor Linux como el que se usó para este ADR.
