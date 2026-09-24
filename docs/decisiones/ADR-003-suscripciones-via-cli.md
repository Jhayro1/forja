# ADR-003 · Usar las suscripciones mediante los CLI oficiales

**Estado:** aceptada, pendiente de confirmar en el spike (T-001, T-002) · 2026-09-24

## Contexto

El usuario quiere usar sus suscripciones de Claude y Codex, no pagar la API por token.
Además, al ser open source, Forja no debe manejar credenciales de terceros.

## Decisión

Forja lanza `claude -p` y `codex exec` como procesos hijos, con el login que el usuario ya
tiene en esos CLI. No lee, copia ni guarda los tokens de sesión de esos CLI.

## Consecuencias

- Costo marginal cero por token dentro de la suscripción; el límite real son los topes de
  uso, que Forja detecta y reparte ([04](../04-modelos-y-costos.md)).
- Dependemos del formato de salida de cada CLI (riesgo R3): parsers tolerantes y fixtures.
- Hay que revisar los **términos de uso** de cada suscripción sobre automatización y
  paralelismo (riesgo R1) y documentarlo con claridad en el README.
- Soporte opcional de API key (variable de entorno del CLI) para quien la prefiera. Con API
  key, `--max-budget-usd` de Claude permite un tope duro por tarea.
- Alternativa a evaluar: el Claude Agent SDK en TypeScript en lugar de parsear el CLI.
