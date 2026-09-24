# M0 · Resultados de las pruebas reales

Fecha: **2026-09-24**. Máquina de pruebas: VPS con Ubuntu 24.04.4 LTS, 4 CPU, 15 GB de RAM, usuario root.
Versiones: Claude Code **2.1.281** · codex-cli **0.156.1** · Node 24.18.0 · bubblewrap 0.9.0 · socat 1.8.0.
Autenticación: suscripciones (Claude por OAuth, `apiKeySource: none`; Codex «Logged in using ChatGPT»).

Salidas reales, sin datos personales, en [`fixtures/`](fixtures/). El script de sondeo está en [`probe.sh`](probe.sh).
Cubre V2-001, V2-002, V2-006, V2-007 y parte de V2-003 y V2-004.

## Resumen

| Tema | Claude | Codex |
|---|---|---|
| Modo batch con eventos JSON | ✅ `-p --output-format stream-json --verbose` | ✅ `exec --json` |
| Salida con esquema JSON | ✅ `--json-schema` → `structured_output` en el `result` | ✅ `--output-schema <archivo>` + `-o` |
| Reanudar por id | ✅ `--resume <session_id>` | ✅ `exec resume <thread_id>` |
| Reanudar tras `kill -9` | ✅ recuerda la tarea | ✅ recuerda la tarea (avisa «tool call output is missing») |
| Reanudar es gratis | ❌ volvió a escribir 8,3k tokens en caché | ❌ 27–28k tokens de entrada |
| Modelo efectivo en los eventos | ✅ `init.model` y `modelUsage` | ❌ no aparece; sólo el pedido con `-m` |
| Costo en los eventos | ✅ `total_cost_usd` (equivalente) | ❌ sólo tokens |
| Carga tus MCP por defecto | ⚠️ sí: 7 de Hostinger (VPS, DNS, facturación…) + conectores de claude.ai | ⚠️ sí: 8 (Hostinger, Cloudflare, shadcn) |
| Cómo se aíslan los MCP | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | `--ignore-user-config` (el login se mantiene) |
| 3–4 procesos a la vez | ✅ 4 simultáneos sin interferencia | ✅ 3 simultáneos sin interferencia |
| RAM por proceso | ~215 MB | ~190 MB + ~40 MB del sandbox |
| Sandbox propio en este servidor | ❌ bloqueado por AppArmor (falla cerrado) | ⚠️ red y escritura aisladas; **lectura de todo el disco** |
| Sandbox propio + bwrap de Forja | disco aislado ✅ · **red de herramientas abierta** ❌ | disco aislado ✅ · red cerrada ✅ |
| Lo que la herramienta aún ve | el login de Claude | el login de Codex |
| `kill -9` del CLI | ❌ **deja el shell huérfano escribiendo** (fuera de su grupo) | ✅ sin huérfanos (`bwrap --die-with-parent`) |

## Catálogo de modelos (V2-006)

| Pedido | Modelo efectivo | Resultado |
|---|---|---|
| `claude --model haiku` | `claude-haiku-4-5-20251001` | ✅ |
| `claude --model sonnet` | `claude-sonnet-5` | ✅ |
| `claude --model opus` | `claude-opus-5-5` | ✅ |
| `claude --model fable` | `claude-fable-5-1` | ❌ **429 `credits_required`**: «You're out of usage credits». En esta cuenta, Fable usa créditos de uso aparte |
| `codex -m gpt-6-luna` | no informado | ✅ |
| `codex -m gpt-6-sol` | no informado | ✅ |
| `codex -m gpt-6-astra` | no informado | ✅ |

## Hallazgos que cambian el diseño

1. **Los MCP del usuario llegan al agente.** Un trabajador barato lanzado sin flags tendría herramientas para comprar VPS, cambiar DNS o tocar facturación. → El adaptador **siempre** lanza con MCP vacío (Claude: `--strict-mcp-config`; Codex: `--ignore-user-config`) y añade sólo lo que la tarea declare. Confirma R04/R10.
2. **Configuración y memoria del usuario.** Con `--setting-sources project,local`, Claude no cargó el `CLAUDE.md` global (respondió `NO_DOKO`). Sin esa opción carga los settings, los plugins y la memoria automática del usuario.
3. **Un «éxito» puede ser falso.** Claude mandó un comando largo a segundo plano, respondió «está ejecutándose» y cerró con `subtype: success`. Al salir mató la tarea (7 de 60). → Lanzar con `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (con eso trabajó en primer plano) y **nunca** tomar el `result` como prueba. Confirma I05.
4. **Un error puede venir como `success`.** El 429 de Fable llega con `subtype: "success"`, `is_error: true`, `api_error_status: 429` y `api_error_code: "credits_required"`. → El parser clasifica por `is_error` y `api_error_*`, no por `subtype`. Categoría `quota`: no escala de modelo (R09) y pasa al siguiente modelo permitido del mismo rol.
5. **Claude deja procesos huérfanos.** Su shell de herramientas corre en otra sesión (`setsid`). Un `kill -9` al CLI no la mata, y el bucle siguió escribiendo en el workspace. → El runner debe contener el **árbol completo**: bwrap con `--die-with-parent --unshare-pid` (con él los hijos mueren con el padre) o un cgroup. Confirma H04/I06.
6. **El sandbox de Codex no protege la lectura.** Sus herramientas leen cualquier archivo, incluidos los logins de Claude y de Codex. → El bwrap de Forja oculta `$HOME` y deja visibles sólo el workspace, el binario y el directorio de configuración de ese CLI. Probado: canario y login ajeno quedan invisibles.
7. **Queda un riesgo residual.** Dentro del bwrap, las herramientas todavía pueden leer el login **del mismo CLI** que las lanzó, porque el CLI lo necesita y comparten sistema de archivos. Hay que aceptarlo explícitamente o seguir investigando (dos zonas de montaje o usuario separado). No hay que copiar tokens.
8. **La red de las herramientas de Claude.** En Ubuntu 24.04 el sandbox de Claude falla con `apply-seccomp: … nested userns is capability-restricted` porque `kernel.apparmor_restrict_unprivileged_userns=1`. Falla cerrado (con `allowUnsandboxedCommands: false` el comando no corre). Sin él, las herramientas de Claude tienen red. Opciones: un perfil de AppArmor para `bwrap` (cambio de sistema, con permiso) o un proxy de salida propio de Forja.
9. **El entorno se hereda.** Una variable con «TOKEN» del proceso padre llegó al agente de Codex. → Entorno por lista positiva (v2 §06). Dentro del bwrap de Forja, con Claude, quedaron 0.
10. **Cada llamada tiene un costo base.** Un «OK» cuesta unos 21k tokens de contexto en Claude por defecto, y unos 13k con el perfil mínimo (6 herramientas, sin MCP ni skills). En Codex son unos 13,6–14,8k. → La granularidad de las tareas debe amortizar ese costo; tareas diminutas no ahorran.
11. **Ruido en stderr.** Claude avisa «no stdin data received in 3s». → Lanzar siempre con stdin en `/dev/null`.

## Perfil de lanzamiento resultante (borrador para V2-018)

Claude, trabajador:
```
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1  <entorno por lista positiva>
bwrap --ro-bind / / --tmpfs $HOME --bind $HOME/.claude … --ro-bind <bin> … --bind <workspace> … \
      --tmpfs /tmp --dev /dev --proc /proc --die-with-parent --unshare-pid \
  claude -p <prompt> --model <m> --output-format stream-json --verbose \
    --permission-mode dontAsk --tools "<lista de la tarea>" --allowedTools "<reglas>" \
    --strict-mcp-config --mcp-config <mcp de la tarea o {}> \
    --setting-sources project,local --disable-slash-commands [--json-schema …] [--resume <id>] < /dev/null
```
Pendiente: montar sólo `.credentials.json` en un directorio de configuración vacío, en lugar de todo `$HOME/.claude` (que contiene transcripciones de otros proyectos).

Codex, trabajador:
```
bwrap --ro-bind / / --tmpfs $HOME --bind $HOME/.codex … --ro-bind <bin> … --bind <workspace> … \
      --tmpfs /tmp --dev /dev --proc /proc --die-with-parent --unshare-pid \
  codex exec --json --ignore-user-config -m <m> -s workspace-write -C <workspace> \
    [--output-schema <f> -o <f>] <prompt> < /dev/null
codex exec resume --json --ignore-user-config -m <m> <thread_id> <prompt>   # resume no acepta -s: verificar política heredada
```
Pendiente: `$HOME/.codex` contiene historial y sesiones de otros proyectos; montar sólo `auth.json` y un `CODEX_HOME` propio por proyecto.

## Qué falta de M0

| Pendiente | Bloquea | Necesita |
|---|---|---|
| Red de las herramientas de Claude (hallazgo 8) | Workers Claude con red cerrada | Tu permiso para el perfil de AppArmor, o que construyamos un proxy de salida |
| Riesgo residual del propio login (hallazgo 7) | Certificar «las herramientas no ven credenciales» | Tu decisión: aceptarlo o seguir investigando |
| Montajes mínimos (sólo credenciales, sin historial) | Aislamiento entre proyectos | Prueba técnica, sin decisión tuya |
| **Sistema operativo de tu PC** | Todo el diseño del sandbox | Tu respuesta: bwrap sólo existe en Linux (WSL2 incluido); macOS y Windows nativo necesitan otro mecanismo |
| Cancelación ordenada (SIGINT/SIGTERM) y cuota agotada de Codex | Clasificación completa de errores | Prueba técnica |
