# Formato · `tareas/T-xxx.yaml`

```yaml
id: T-014
titulo: Endpoint POST /fiados
tipo: interfaz                 # esquema | persistencia | servicio | interfaz | aceptacion | adaptador | disparador | verificacion-rnf | arreglo-integracion | resolver-conflicto
origen: [UC-001]               # trazabilidad
ola: 2
depende_de: [T-010, T-011]
complejidad: media             # baja | media | alta (alta empieza en nivel medio)
nivel: barato
archivos:                      # sólo puede modificar esto (globs)
  - src/fiados/api/**
  - src/fiados/api.test.ts
solo_lectura:                  # se incluyen como firmas en el paquete
  - src/fiados/servicio.ts
  - src/db/schema.ts
listo_cuando:
  tests: [tests/aceptacion/UC-001.test.ts]
  comandos: [typecheck, lint]
requiere: []                   # p. ej. [cloudflare-principal:dns:leer]
red: false
presupuesto_usd: 0.40
notas: |
  Usar el validador de E-2 del contrato T-010. Montos en céntimos (D-01).
hash_origen: 9f2c…             # hash de los fragmentos del spec que la originaron
```

## Estados (proyección)

```
pendiente → lista → corriendo → verificando → aprobada → uniendo → unida
                 ↘ esperando_boveda / esperando_respuesta / pausada
     corriendo|verificando → fallida (intento n) → lista (mismo o siguiente nivel)
                          → bloqueada (necesita al usuario)
     cualquiera → invalidada (cambio de spec) | cancelada
```
