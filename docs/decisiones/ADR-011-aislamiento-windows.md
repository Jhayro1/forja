# ADR-011 · Aislamiento en Windows nativo (AppContainer + Job Object)

**Estado:** propuesta · prototipo sin probar en Windows · 2026-09-26

## Contexto

El aislamiento de los agentes usa bubblewrap, que sólo existe en Linux. Hasta ahora, la única
forma soportada de usar Forja en Windows es dentro de WSL2 (Linux real, mismo `bwrap`). Este
ADR evalúa un aislamiento **nativo** de Windows, sin pasar por WSL, para el día en que
`forja run` deba funcionar directo desde PowerShell.

A diferencia de Linux (que junta mounts, PID, red y usuario en un solo namespace) y de
Seatbelt en macOS (un único perfil declarativo, ADR-010), Windows no tiene un mecanismo
equivalente único. Hay que combinar tres primitivas distintas, cada una con sus propios
huecos:

| Garantía que da bwrap | Primitiva de Windows | Huecos conocidos |
|---|---|---|
| Namespace de mounts (remapea rutas) | Ninguna equivalente | El agente recibe rutas reales por variable de entorno, igual que Seatbelt |
| Namespace de PID (matar el árbol) | **Job Object** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) | Un proceso con `CREATE_BREAKAWAY_FROM_JOB` escapa si el job no fija `JOB_OBJECT_LIMIT_BREAKAWAY_OK = false` |
| Ocultar HOME real en lectura y escritura | **AppContainer** (token con SID de paquete) + ACLs (`icacls`) | El AppContainer deniega **escritura** fuera de lo permitido por defecto, pero **no lectura**: para ocultar el HOME real en lectura hace falta una regla ACL de denegación explícita añadida antes del lanzamiento y quitada después |
| Sin red salvo el socket del proxy | **WFP** (Windows Filtering Platform), reglas atadas al SID del AppContainer | Requiere una API mucho más compleja que bwrap; sin ella, la red queda abierta (igual que Seatbelt sin proxy) |

Node no tiene bindings nativos para `CreateAppContainerProfile`, Job Objects ni WFP. Cualquier
implementación real necesita un helper compilado aparte (candidato: Rust + crate
`windows-rs`, empaquetado como `optionalDependency` por arquitectura, igual que hacen
`esbuild`/`swc`).

## Decisión (propuesta)

Igual que con Seatbelt: modelar el plan de aislamiento como datos puros, con el mismo
contrato de `SandboxSpec`, y declarar por escrito lo que no puede garantizar. El prototipo
vive en `src/runtime/windows-sandbox.ts` (`windowsSandboxPlan`), con pruebas del plan
generado (`test/runtime/windows-sandbox.test.ts`). **No está conectado al lanzador ni existe
el helper nativo**: nadie lo ha corrido en Windows.

El plan declara:

- un `profileId` por lanzamiento (nombre del AppContainer);
- `grants`: rutas y si son de lectura o lectura-escritura (workspace, HOME falso, mounts del
  proveedor, ayudas de Forja) — se traducen a `icacls` cuando exista el helper;
- `denyReadPaths`: el HOME real, para la regla ACL de denegación explícita;
- `env`: rutas reales que el agente necesita porque no hay remapeo;
- `limitations`: cada hueco de la tabla de arriba, siempre presente y nunca implícito.

## Lo que falta para darla por aceptada

1. Escribir el helper nativo (Rust + `windows-rs`) que de verdad cree el AppContainer, aplique
   las ACLs, arme el Job Object y (si se resuelve el punto 2) las reglas WFP.
2. Resolver la red: sin WFP funcionando, la Fase 2 de esta ADR se publica como limitación
   conocida en vez de resuelta — no se asume aislamiento de red que no existe.
3. Correr en Windows real `forja doctor` y una sonda de aislamiento equivalente a la de
   Seatbelt: debe fallar al leer el HOME real, al escribir fuera del espacio permitido y (una
   vez resuelto el punto 2) al abrir red fuera del proxy.
4. Conectar `windowsSandboxPlan` en `launcher.ts` detrás de `sandbox.mode: windows-nativo`, y
   que `forja doctor` detecte el helper y los privilegios necesarios.
5. Quitar o abrir la restricción `"os": ["linux"]` de `package.json` sólo cuando 1–4 estén
   probados — no antes.

Hasta entonces, la única vía soportada para Windows sigue siendo WSL2 (ver
[INSTALAR.md](../guias/INSTALAR.md)).
