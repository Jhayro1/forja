# 01 · Glosario

| Término | Significado |
|--------|-------------|
| **Proyecto** | Un repositorio gestionado por Forja. Tiene su propia especificación, estado, memoria y bóveda. |
| **Planeador** | Modelo de nivel alto (Opus, Fable, sol, Astra) con el que conversa el usuario. Decide, no teclea. |
| **Trabajador** (worker) | Proceso de un CLI (`claude -p`, `codex exec`) con modelo barato o medio que ejecuta una tarea. |
| **Orquestador** | Código de Forja que planifica, lanza, vigila, reintenta y registra. No usa LLM. |
| **Nivel** | Categoría de modelo: `planeador`, `medio`, `barato`. Cada nivel se asigna a modelos concretos en `forja.yaml`. |
| **Escalera** | Regla que sube una tarea de nivel cuando falla: barato → medio → planeador. |
| **Fase** | Etapa del flujo: Analizar, Descubrir, Especificar, Dividir, Ejecutar, Verificar, Unir. |
| **Puerta** | Punto donde el flujo se detiene hasta que el usuario aprueba (p. ej. antes de Ejecutar). |
| **spec.json** | Salida estructurada del planeador: todo lo decidido, sin prosa. Es la fuente de los documentos. |
| **Plantilla** | Archivo que convierte `spec.json` en `.md`, `.feature` o `.yaml` sin gastar tokens. |
| **Caso de uso (UC)** | Interacción de un actor con el sistema: flujo principal, alternos, excepciones y criterios. |
| **Criterio de aceptación** | Condición verificable en formato Given/When/Then. Cada una produce al menos un test. |
| **Tarea (T)** | Unidad de trabajo para un trabajador: archivos permitidos, dependencias, tests de salida y presupuesto. |
| **Ola** | Conjunto de tareas sin dependencias pendientes entre sí, que pueden correr en paralelo. |
| **Contrato** | Interfaz, tipo o esquema que fija una tarea de la primera ola y del que dependen otras. |
| **Paquete de contexto** | Texto mínimo que recibe un trabajador: su tarea, reglas, decisiones y archivos relevantes, dentro de un presupuesto de tokens. |
| **Memoria** | Grafo de nodos (casos de uso, reglas, decisiones, archivos, funciones…) y aristas con nombre. |
| **Decisión (D)** | Algo resuelto en una conversación que no estaba en la especificación. Se guarda en el repo y en la memoria. |
| **Lección (L)** | Nota que deja un fallo resuelto («en este repo los tests requieren `TZ=UTC`»). |
| **Evento** | Registro inmutable de un cambio de estado. El estado actual se calcula a partir de los eventos. |
| **Worktree** | Copia de trabajo de git independiente, una por tarea, para que los trabajadores no se pisen. |
| **Cola de merge** | Proceso que integra ramas de tareas terminadas en orden de dependencias. |
| **Bóveda** | Almacén cifrado de secretos y variables, con alcance global o por proyecto. |
| **Secreto** | Valor sensible (token, contraseña). Nunca se muestra, nunca va al prompt y se redacta de los logs. |
| **Conexión** | Agrupación con nombre de secretos y variables para un servicio (p. ej. `cloudflare-principal`), con sus permisos. |
| **Servidor MCP** | Servidor de herramientas (Model Context Protocol) que se entrega a un agente, configurado con secretos de la bóveda. |
| **Acción externa** | Operación con efecto fuera del repo (DNS, enviar correo, deploy). Requiere vista previa y aprobación. |
| **Perfil del proyecto** | Comandos detectados para instalar, compilar, probar y lint, más el stack. |
| **Daemon** | Proceso `forja serve` que corre el orquestador y la UI. El CLI se comunica con él. |
