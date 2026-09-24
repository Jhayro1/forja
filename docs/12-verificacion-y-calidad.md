# 12 · Verificación y calidad

## Tests primero

Los criterios de aceptación se convierten en tests **antes** de escribir el código:

1. La fase Especificar genera `.feature` y esqueletos de test pendientes.
2. En la ola 0, además de los contratos, van tareas `aceptacion` que convierten los
   esqueletos en tests reales que **fallan** (rojo), usando los contratos.
3. Las tareas de implementación terminan cuando **esos** tests pasan (verde).

Así el agente barato tiene un objetivo que se comprueba solo, y su criterio no
decide si terminó.

## Protección contra trampas

Un modelo barato presionado puede «hacer pasar» los tests por el camino corto. Por eso:
- las tareas de implementación **no pueden modificar** los tests de aceptación: son
  archivos fuera de su lista de `archivos`, y el verificador rechaza cualquier diff que los toque;
- el verificador busca patrones sospechosos: tests saltados (`.skip`, `t.Skip`),
  aserciones borradas, `// @ts-ignore` nuevos, mocks del sistema bajo prueba;
- el revisor recibe el diff y los criterios, y responde con un JSON de verificación.

## Tubería de verificación por tarea

```
1. ¿El diff respeta los archivos permitidos?          (código, 0 tokens)
2. Escaneo de secretos del diff                        (código)
3. build / typecheck                                   (perfil del proyecto)
4. lint                                                (perfil)
5. tests de la tarea                                   (perfil)
6. tests existentes afectados (según el grafo)         (perfil)
7. revisor barato: diff + criterios → {aprobado, problemas[]}   (LLM barato, salida con esquema)
```

Se detiene en el primer fallo. Los pasos 1 a 6 no gastan tokens, así que el revisor sólo
ve código que ya compila y pasa sus tests.

## Qué pasa cuando falla

| Fallo | Acción |
|------|--------|
| Tocó archivos no permitidos | Se revierten esos archivos y se reintenta avisando |
| Build, lint o tests | Reintento en el mismo nivel con la salida del error (recortada a lo relevante) |
| Segundo fallo | Sube de nivel con el diff y el historial de errores |
| Revisor con problemas | Reintento con la lista de problemas |
| Fallo en el nivel planeador | `bloqueada`: te llega una notificación con el resumen y opciones |
| Fallo que se repite en varias tareas | Se sugiere una **lección** o una corrección de la especificación |

## Lecciones

Cuando una tarea pasa después de fallar, se pide al modelo que la resolvió una línea de
«qué aprendí que sirva a otros» (es opcional y barato). Si es útil y general, se guarda como
`L-*.md` y como nodo en la memoria. Ejemplos: «usa `pnpm` y no `npm`», «los tests necesitan
`TZ=UTC`», «el ORM no soporta X, usar Y».

## Perfil del proyecto

Se detecta en Analizar o en `forja nuevo` y se guarda en `forja.yaml`:

```yaml
perfil:
  stack: [typescript, node, next, postgres]
  gestor: pnpm
  comandos:
    instalar: pnpm install --frozen-lockfile
    build: pnpm -r build
    typecheck: pnpm -r typecheck
    lint: pnpm -r lint
    test: pnpm -r test
    test_archivo: pnpm vitest run {archivo}
  servicios_para_tests: [postgres]     # docker compose o similar
```

## Cola de merge

- Integra en orden topológico sobre `forja/integracion`.
- Después de cada merge corre la suite completa. Si se rompe algo que antes pasaba,
  revierte ese merge y crea una tarea `arreglo-integracion` de nivel medio.
- Al final: informe (tareas, intentos, escalados, costo, tests) y la opción de abrir un PR
  a la rama principal. **Nunca** hace merge a `main` por su cuenta.
