# Formato · `forja.yaml` (en el repo, sin secretos)

```yaml
version: 1
proyecto:
  id: prj_01J9Z3K8Q2W7M4X6T5R1V0B8N3     # estable; no cambiar a mano
  nombre: mi-bodega

niveles:                                 # sobrescribe ~/.forja/config.yaml
  planeador: [claude:opus, codex:sol]
  medio:     [claude:sonnet]
  barato:    [claude:haiku, codex:mini]
revisor_otro_proveedor: true             # el revisor es de otro proveedor que el autor

ejecucion:
  paralelo_max: 4
  max_intentos: 4
  permitir_nivel_planeador_en_escalera: true
  checkpoint_minutos: 5

presupuesto:                             # costo equivalente en USD
  por_tarea_defecto: 0.50
  por_proyecto: 30
  por_dia: 10

contexto:
  tokens_barato: 12000
  tokens_medio: 25000
  saltos: 2

perfil:                                  # detectado; editable
  stack: [typescript, node]
  gestor: pnpm
  comandos:
    instalar: pnpm install --frozen-lockfile
    build: pnpm -r build
    typecheck: pnpm -r typecheck
    lint: pnpm -r lint
    test: pnpm -r test
    test_archivo: pnpm vitest run {archivo}

conexiones:                              # nombres; los valores están en la bóveda
  - cloudflare-principal                 # global, declarada para este proyecto
  - smtp-empresa                         # del proyecto

analizar:
  excluir: [dist/**, node_modules/**, "**/*.min.js"]

ramas:
  principal: main
  integracion: forja/integracion
  prefijo_tareas: forja/
```
