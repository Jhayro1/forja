# Forja (nombre provisional)

> **Nota (2026-09-24):** esta es la versión 1 del diseño y queda como historial. **La versión vigente es [v2/](v2/LEEME-PRIMERO.md).**

Orquestador **open source** de agentes de código. Separa el trabajo en dos:

1. **Pensar**: con modelos caros (Claude Opus / Fable, Codex sol / Astra), una sola vez,
   conversando contigo hasta dejar todo decidido y documentado.
2. **Teclear**: con modelos baratos, muchas veces y en paralelo, cada agente con sólo el
   contexto que necesita y con tests que le dicen cuándo terminó.

Funciona con las **suscripciones** de Claude y Codex: maneja sus CLI oficiales
(`claude -p`, `codex exec`) y nunca toca tus credenciales de esos servicios.

> Estado: **definición**. Aquí sólo hay documentación; todavía no hay código.
> El propio proyecto se especifica con el método que va a automatizar.

## Cómo leer esta carpeta

| # | Documento | De qué trata |
|---|-----------|--------------|
| 00 | [Visión](docs/00-vision.md) | Problema, objetivo, principios y lo que **no** es |
| 01 | [Glosario](docs/01-glosario.md) | Palabras con significado fijo en todo el proyecto |
| 02 | [Arquitectura](docs/02-arquitectura.md) | Componentes, procesos y estructura del repositorio |
| 03 | [Flujo por fases](docs/03-flujo-fases.md) | Las 7 fases, sus entradas, salidas y puertas de aprobación |
| 04 | [Modelos y costos](docs/04-modelos-y-costos.md) | Niveles, escalera, presupuestos, límites de suscripción |
| 05 | [Generación barata de documentos](docs/05-generacion-barata.md) | El LLM decide, el código escribe |
| 06 | [Memoria en grafo](docs/06-memoria-grafo.md) | Nodos, aristas, relevancia, paquete de contexto |
| 07 | [Persistencia y recuperación](docs/07-persistencia-y-recuperacion.md) | Si se cae o lo cierras, retoma donde quedó |
| 08 | [Proyectos](docs/08-proyectos.md) | Todo separado por proyecto |
| 09 | [Bóveda: secretos y conexiones](docs/09-boveda-secretos-y-conexiones.md) | Variables, tokens, SMTP, MCP, herramientas externas |
| 10 | [Seguridad y acciones externas](docs/10-seguridad-y-acciones-externas.md) | Permisos, aprobaciones, auditoría |
| 11 | [Proveedores](docs/11-proveedores.md) | Adaptadores de Claude y Codex (y futuros) |
| 12 | [Verificación y calidad](docs/12-verificacion-y-calidad.md) | Tests primero, revisión, escalado, merge |
| 13 | [Interfaz (UI)](docs/13-ui.md) | Las vistas del panel |
| 14 | [CLI](docs/14-cli.md) | Todos los comandos |
| 15 | [Roadmap](docs/15-roadmap.md) | Hitos, del spike a la publicación |
| 16 | [Backlog del MVP](docs/16-backlog.md) | Tareas con dependencias, listas para ejecutar |
| 17 | [Riesgos y preguntas abiertas](docs/17-riesgos-y-preguntas.md) | Lo que falta decidir o comprobar |
| — | [Decisiones (ADR)](docs/decisiones/) | Por qué se eligió cada cosa |
| — | [Casos de uso](docs/casos-de-uso/) | UC-01 … UC-14 con flujos, excepciones y criterios |
| — | [Formatos](docs/formatos/) | `forja.yaml`, `spec.json`, tareas, eventos, bóveda |

## Decisiones principales

- **Lenguaje: TypeScript sobre Node 24** ([ADR-001](docs/decisiones/ADR-001-lenguaje.md)).
- **El orquestador es código, no un LLM**: coordinar no gasta tokens ([ADR-002](docs/decisiones/ADR-002-orquestador-determinista.md)).
- **Suscripciones mediante los CLI oficiales** ([ADR-003](docs/decisiones/ADR-003-suscripciones-via-cli.md)).
- **El LLM devuelve JSON y las plantillas escriben los `.md`** ([ADR-004](docs/decisiones/ADR-004-spec-json-y-plantillas.md)).
- **Memoria en grafo sobre SQLite**, construida casi sin tokens ([ADR-005](docs/decisiones/ADR-005-memoria-grafo-sqlite.md)).
- **Estado por eventos en SQLite**: sobrevive a caídas y reinicios ([ADR-006](docs/decisiones/ADR-006-estado-por-eventos.md)).
- **Bóveda cifrada fuera del repo**: los secretos se inyectan al proceso y nunca van al prompt ([ADR-007](docs/decisiones/ADR-007-boveda.md)).
- **El repo es la verdad**: las bases de datos son estado de ejecución o índices reconstruibles ([ADR-008](docs/decisiones/ADR-008-repo-es-la-verdad.md)).
- **Licencia Apache-2.0** ([ADR-009](docs/decisiones/ADR-009-licencia.md)).

## Qué se agregó respecto a la idea original

Además de lo que pediste (planear con caros, programar con baratos, ver agentes y
costos, analizar código existente, conectar Claude y Codex, recuperación, proyectos
separados y bóveda de credenciales), el diseño incluye:

- **Puertas de aprobación**: nada pasa de especificación a código sin tu visto bueno.
- **Estimación de costo antes de ejecutar**: `forja run --estimar`.
- **Contratos primero**: la primera ola de tareas fija interfaces y tipos, y las demás se apoyan en ellos.
- **Cambios de especificación a mitad de camino**: el grafo dice qué tareas quedan invalidadas.
- **Cola de merge** en orden de dependencias, con tests de integración en cada paso.
- **Preguntas que suben**: el agente barato pregunta a la memoria, luego al planeador y sólo al final a ti.
- **Lecciones aprendidas**: cada fallo resuelto deja una nota que la memoria reutiliza.
- **Perfil del proyecto**: comandos de build, test y lint detectados una vez y reutilizados.
- **Límites de suscripción**: detecta «límite alcanzado», pausa ese proveedor y reparte a otro.
- **Acciones externas con vista previa** (DNS, correo, deploy): muestran el diff y esperan tu aprobación.
- **Auditoría y redacción**: todo queda registrado y ningún secreto aparece en logs.
- **Notificaciones** cuando algo espera tu decisión.
