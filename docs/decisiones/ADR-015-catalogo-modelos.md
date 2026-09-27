# ADR-015 · Catálogo de modelos y esfuerzo de razonamiento por rol

**Estado:** aceptado · 2026-09-27

## Contexto

`forja.yaml` ya permitía elegir modelos por rol (`planeador`, `trabajador`, `complejo`,
`revisor`), pero el panel sólo sugería seis y no había forma de pedir más o menos
razonamiento. Los CLI lo permiten: Claude Code con `--effort` y Codex con
`model_reasoning_effort`.

## Decisión

- `src/providers/catalog.ts` es la única fuente de los modelos que se ofrecen: alias y
  versiones fijas de Claude Code (`default`, `best`, `opusplan`, `fable`, `opus`, `sonnet`,
  `haiku`, variantes `[1m]`, `claude-fable-5-1`… `claude-haiku-4-5`) y de Codex
  (`gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.5` en retiro), cada uno con los niveles
  de esfuerzo que acepta. Lo usan el panel, `forja modelos` y los adaptadores.
- `forja.yaml` gana `esfuerzo.<rol>` (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Es
  por rol, no por modelo: cada modelo del rol recibe el nivel más alto que acepta sin pasarse
  del pedido (Luna no admite `ultra` → `max`; Haiku no tiene esfuerzo → no se pasa nada).
  Sin la clave, cada CLI usa su valor por defecto. Los `forja.yaml` existentes siguen valiendo.
- `roles` acepta el sufijo `[1m]` de Claude Code.
- Un modelo fuera del catálogo se puede escribir igual («Otro» en el panel): el CLI decide.

Fuentes: [configuración de modelos de Claude Code](https://code.claude.com/docs/en/model-config) y
[modelos de Codex](https://learn.chatgpt.com/docs/models), revisadas en septiembre de 2026.

## Consecuencias

- Añadir un modelo es una línea en el catálogo.
- Los niveles `ultra` (Codex) y `ultracode` (Claude) no se probaron contra los CLI reales;
  `ultracode` no se ofrece hasta comprobarlo.
