# Usar Forja para desarrollar Forja

Forja puede trabajar sobre su propio repositorio. La regla es que **el Forja que supervisa no
debe cambiar mientras supervisa**. Los agentes trabajan en worktrees aparte, así que no editan
el código en ejecución. Pero reconstruir (`npm run build`) o cambiar de rama en el checkout sí
cambiaría el supervisor a mitad de un run.

## Copia estable

```bash
bash scripts/forja-estable.sh            # última etiqueta (o HEAD si no hay)
bash scripts/forja-estable.sh v0.3.0     # una versión concreta
alias forja-estable='node ~/.forja-estable/actual/dist/cli/bin.js'
forja-estable run
```

El script copia sólo lo versionado en ese commit (`git archive`, nada del árbol de trabajo), lo
instala y compila en `~/.forja-estable/<commit>`, y apunta `actual` a esa copia. Instalar la
misma versión otra vez no hace nada. Para cambiar de versión, cuando lo decidas, vuelve a
correrlo con otra etiqueta.

## Aviso

Si `forja run` se ejecuta desde el mismo repositorio que va a cambiar, lo dice al empezar
(`src/run/self-host.ts`). No lo impide: a veces es justo lo que quieres, por ejemplo para
probar un cambio del orquestador sobre sí mismo en una rama desechable.
