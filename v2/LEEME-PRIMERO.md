# Forja en 5 minutos

Resumen en lenguaje llano de todo el plan v2. El detalle técnico está en los capítulos 00–13; aquí sólo va lo que hay que entender.

## Qué es

Una herramienta de terminal, open source, que te ayuda a construir software con agentes **gastando menos y sin perder calidad**:

1. **Conversas con un modelo caro** (Claude Opus/Fable o Codex GPT-6-Astra). Él te pregunta, detecta lo que falta, te propone ideas y deja todo decidido y documentado: casos de uso, excepciones, criterios de aceptación y tareas.
2. **Apruebas el plan.** Antes de aprobar no se escribe ni una línea de código.
3. **Varios agentes baratos programan a la vez** (Claude Haiku/Sonnet, Codex GPT-6-Luna/Sol), cada uno en su tarea y su copia del repo, con sólo el contexto que necesita.
4. **Forja comprueba cada resultado** con tests que el agente no puede tocar, lo integra en una rama y te entrega todo con la evidencia de lo que se hizo.

Tú sólo hablas con el modelo caro. A los baratos los organiza Forja, que es código normal y no gasta tokens en coordinar.

## En qué se diferencia de lo que ya existe

- **Paralelismo real entre tareas.** Claude Code o Codex pueden lanzar subagentes, pero todos trabajan en *una* tarea. Forja lleva *varias tareas distintas* a la vez (3 por defecto): la API, la pantalla y las validaciones avanzan juntas. Si una tarea sólo espera a otra, arranca apenas esa otra termina, sin esperar al resto.
- **Claude y Codex juntos.** Usa tus dos suscripciones a la vez y reparte el trabajo entre ambas. Cuando una llega a su límite de uso, la otra sigue.
- **Todo se ve.** Un tablero en la terminal muestra qué agente hace qué, con qué modelo, cuánto lleva gastado, sus logs, su diff y lo que está esperando tu respuesta.
- **Nada queda a medias.** Si se cae el servidor o cierras la terminal, al volver Forja revisa qué pasó con cada agente y retoma. Si no puede saber algo con seguridad, te lo dice en lugar de adivinar.

## Modelos (verificados en este servidor el 24-09-2026)

| Rol | Claude | Codex |
|---|---|---|
| Planear contigo | `opus`, `fable` | `gpt-6-astra` (el más potente) |
| Tareas difíciles y revisión | `sonnet` | `gpt-6-sol` (el de uso diario para programar) |
| Tareas simples | `haiku` | `gpt-6-luna` (rápido y económico) |

Todo esto se cambia en `forja.yaml`. Cuando sale un modelo nuevo, primero se prueba y después se habilita.

Escalado: si una tarea falla dos veces con un modelo barato, pasa a uno mejor. Quedarse sin presupuesto o sin cuota **no** sube de modelo; Forja pausa y te avisa.

## Lo que aprendimos al revisar v1 (y ya está corregido)

| Problema en v1 | Cómo queda en v2 |
|---|---|
| Los secretos iban en el entorno del agente: con `env` los podía leer | El agente nunca tiene tus credenciales. Pide la operación («cambia este registro DNS») y un ejecutor aparte, que sí tiene el token, la hace después de que tú apruebes |
| Una tarea arrancaba cuando su dependencia estaba aprobada, aunque su código aún no estuviera integrado | Sólo arranca cuando el código de la dependencia **ya está integrado y verificado** |
| Quedarse sin presupuesto contaba como fallo y subía a un modelo más caro | Presupuesto y cuota pausan; nunca escalan |
| Sólo se protegían los archivos de test | Se protegen tests, fixtures, scripts y configuración de verificación |
| Se asumía que un worktree aislaba al agente | El aislamiento lo pone el sistema operativo (sandbox); el worktree sólo separa archivos |
| Se prometía «nada se pierde» | Se promete lo que se puede comprobar, y lo dudoso se marca como «desconocido» |

## Cómo se usa (cuando esté hecho)

```bash
forja nuevo mi-app                 # o: forja importar /ruta/al/repo
forja planear                      # conversación con el planeador
forja aprobar plan                 # muestra qué se hará y cuánto se estima
forja run                          # 3 agentes en paralelo (--paralelo N)
forja tablero                      # ver todo en vivo, navegable con el teclado
forja entrega preparar             # rama local + informe; push/PR sólo si tú lo pides
```

## En qué orden se construye

| Etapa | Qué queda funcionando |
|---|---|
| **M0 · Pruebas reales** | Confirmar con los CLI de verdad: modelos, salida en streaming, reanudar, sandbox, 3 procesos a la vez y qué pasa si el proceso muere. Sin esto no se programa el resto |
| **M1 · Núcleo** | Estado que sobrevive caídas, supervisor de procesos, adaptadores de Claude y Codex, proveedor simulado para tests sin gastar tokens |
| **M2 · Planear** | Conversación con el planeador, spec validada, documentos generados, plan con estimación y aprobación |
| **M3 · Ejecutar** ⭐ | Agentes en paralelo, verificación, integración, recuperación y tablero de terminal. **Primer producto usable** |
| M4 · Beta | Panel web, piloto que mide calidad y costo real, empaquetado para publicar |
| M5 · Conexiones | Bóveda y ejecutor para Cloudflare, SMTP, MCP, etc., con vista previa y aprobación |
| M6 · Memoria avanzada | Grafo del código y del proyecto para dar un contexto más preciso |

## Reglas que no se rompen

- Sin tu aprobación no se ejecuta código, ni se toca nada externo, ni se hace push.
- Los agentes no ven tus credenciales ni pueden tocar los tests que los evalúan.
- Nada se borra solo: pausar o archivar conserva todo, y limpiar pide confirmación.
- Si algo falla, se muestra el error tal cual.

## Dónde leer más

Diagnóstico de v1 → [00](00-diagnostico.md) · Paralelismo → [05](05-ejecucion-y-recuperacion.md#paralelismo-entre-tareas-mvp-d2-16) · Seguridad → [06](06-seguridad-y-conexiones.md) · Modelos → [07](07-proveedores-y-costos.md#catálogo-inicial-de-modelos) · Tablero → [10](10-cli-ui-y-api.md#tablero-de-terminal-mvp) · Plan de trabajo → [11](11-roadmap-y-backlog.md) · Planeador → [13](13-planeador-proactivo-y-prompts.md)
