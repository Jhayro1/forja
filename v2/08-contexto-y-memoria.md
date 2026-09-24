# Contexto, análisis y memoria

## MVP

Paquete determinista: objetivo, criterios, reglas aplicables, dependencias y contratos integrados, decisiones vigentes, perfil aprobado, archivos relevantes, base SHA y restricciones. Búsqueda por IDs y texto, sin PageRank, embeddings ni aprendizaje automático inicial.

El límite es configurable por modelo y tarea; 12k/25k de v1 son valores experimentales, no garantía de suficiencia. Reservar capacidad para salida y herramientas. Si las reglas críticas no caben, dividir tarea o aumentar contexto dentro del presupuesto; nunca truncarlas silenciosamente.

Guardar manifiesto con hash por fragmento, procedencia, revisión, motivo de inclusión, elementos excluidos y estimación de tokens. El paquete es reproducible con iguales entradas y versión del selector. No afirmar que el proveedor cacheará el prefijo ni que sólo consumirá ese paquete: el CLI puede añadir instrucciones y usar herramientas.

## Análisis de repos existentes

Inventario estático primero: manifiestos, estructura, rutas, tamaño, lenguajes, pruebas y configuración. Respetar exclusiones de seguridad además de `.gitignore`; los archivos ya versionados también pueden contener secretos. Detectar symlinks y no seguirlos fuera del alcance. `.env`, llaves, binarios grandes y artefactos generados no entran al modelo por defecto.

Los resúmenes incluyen ruta y hash fuente, modelo/prompt y fecha. El planeador puede inspeccionar código para comprobar una afirmación; cinco líneas por módulo no bastan para inferir una arquitectura correcta. Toda conclusión distingue observación, inferencia y duda.

Invalidar resumen por cambios de contenido, configuración, parser, reglas de extracción o prompt. Un cambio del contrato de un módulo puede exigir revisar consumidores aunque sus archivos no hayan cambiado. Reanálisis sin cambios ni invalidaciones puede reutilizar resultados completos sin llamadas.

## Grafo posterior

Nodos: requisitos, criterios, decisiones, tareas, archivos, símbolos y conexiones sin valores. Aristas: implementa, verifica, depende, define, importa, aplica y afecta. Cada arista guarda origen, revisión, confianza y método de extracción.

Tree-sitter aporta sintaxis. Imports dinámicos, resolución de alias, despacho dinámico y relaciones de llamadas requieren resolución adicional; marcar «posible» cuando no esté demostrada. No usar ausencia de arista para afirmar ausencia de impacto.

Selector inicial del grafo: incluir obligatorios, recorrer dependencias explícitas, agregar fragmentos por relevancia y desempate estable por ID. Ciclos se cortan con visitados y límites de nodos/profundidad. PageRank y refuerzo de utilidad sólo se añaden si mejoran evaluaciones: haber estado presente en una tarea exitosa no demuestra utilidad causal.

## Contexto adicional y memoria aprendida

Worker puede pedir archivos o decisiones adicionales mediante solicitud con motivo. Forja resuelve autorización, cuota y procedencia, y registra la ampliación. Recuperar más contexto no debe obligar a leer medio repo sin control.

Lecciones inicialmente son propuestas con evidencia, ámbito, versión y fecha. No ascienden a política automáticamente. Una solución accidental o una instrucción inyectada no se convierte en regla global. Decisiones aprobadas prevalecen sobre lecciones; conflictos se muestran.

Embeddings son opcionales para localizar puntos de entrada. Se deberá decidir proveedor, privacidad y costo antes de enviar código. El índice se reconstruye desde fuentes versionadas; pesos aprendidos son auxiliares exportables y no condición de corrección.
