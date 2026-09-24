# 00 · Visión

## Problema

Construir software con agentes hoy es **caro o lento**:

- Si todo lo hace un modelo caro, cada línea cuesta tokens de modelo caro.
- Si todo lo hace un modelo barato, se equivoca porque le falta contexto o criterio.
- Herramientas como OpenSpec ordenan el trabajo en tareas, pero avanzan de a una, o
  delegan en el propio modelo la creación de subagentes, y eso gasta tokens sólo en coordinar.
- Cada agente relee medio repositorio para entender qué hacer: se paga una y otra vez
  por el mismo contexto.
- No se ve qué está haciendo cada agente ni cuánto se lleva gastado.

## Objetivo

Una herramienta local y open source que:

1. **Te ayuda a definir** el sistema conversando sólo con modelos de primer nivel, hasta
   dejar todo decidido: casos de uso, flujos alternos, excepciones, criterios de
   aceptación, modelo de datos y plan de pruebas.
2. **Documenta automáticamente y casi sin tokens**: el modelo devuelve decisiones
   estructuradas y el código genera los documentos.
3. **Divide en tareas pequeñas** con dependencias, archivos permitidos y tests que
   definen cuándo están listas.
4. **Lanza agentes baratos en paralelo**, cada uno con un paquete de contexto mínimo,
   y los verifica con tests.
5. **Muestra todo**: fases, agentes, logs en vivo, grafo de tareas y costos.
6. Sirve igual para **proyectos nuevos** y para **mejorar código existente**.
7. **No pierde nada**: si se cierra o se cae, retoma donde quedó.
8. **Maneja credenciales** de servicios externos (Cloudflare, SMTP, MCP, etc.) de forma
   segura y con aprobación para acciones con efecto real.

## Para quién

- Desarrolladores individuales y equipos pequeños con suscripción de Claude o Codex
  que quieren multiplicar lo que hacen sin multiplicar el gasto.
- Quien mantiene un sistema existente y quiere mejoras bien especificadas.

## Principios

1. **Caro para decidir, barato para ejecutar.** Un modelo caro nunca escribe lo que una
   plantilla o un modelo barato pueden escribir.
2. **Coordinar no cuesta tokens.** El orquestador es código determinista.
3. **Contexto mínimo suficiente.** Cada agente recibe sólo lo que su tarea necesita.
4. **Lo verificable manda.** Una tarea termina cuando sus tests pasan, no cuando el agente dice que terminó.
5. **El repo es la verdad.** Todo lo decidido queda en archivos versionables; las bases de datos se pueden reconstruir o son estado de ejecución.
6. **Nada se pierde.** Cada cambio de estado es un evento persistido antes de actuar.
7. **Secretos fuera del prompt.** Las credenciales viajan por el entorno del proceso y nunca por el texto que lee el modelo.
8. **Efectos reales con permiso.** Lo que toca el mundo exterior (DNS, correo, deploy) se muestra antes y se aprueba.
9. **Tú hablas sólo con el planeador.** Los agentes baratos nunca te interrumpen directamente.

## Lo que NO es

- No es un IDE ni reemplaza a Claude Code o a Codex: los **usa**.
- No es un servicio en la nube: corre en tu máquina o en tu servidor.
- No revende acceso a modelos ni guarda credenciales de Claude o Codex.
- No despliega a producción por su cuenta: puede preparar y proponer, y se ejecuta sólo con aprobación.

## Cómo sabremos que funciona (métricas)

| Métrica | Meta del MVP |
|--------|---------------|
| Tokens de modelo caro por proyecto, frente a hacerlo todo con modelo caro | −70 % o más |
| Tareas que pasan sus tests sin escalar al modelo caro | ≥ 75 % |
| Tiempo desde «spec aprobada» hasta «todo en verde» con 4 agentes frente a 1 | ≤ 40 % |
| Recuperación tras matar el proceso a mitad de ejecución | 100 % de tareas retomadas, 0 perdidas |
| Secretos encontrados en logs, transcripciones o repo | 0 |
