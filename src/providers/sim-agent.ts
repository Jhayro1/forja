#!/usr/bin/env node
/**
 * Scripted fake agent. Reads a script (JSON) and the prompt from stdin, performs
 * the steps on the real filesystem (inside the sandbox) and prints Claude-style
 * stream-json. Lets the whole pipeline run in tests and demos without quota.
 *
 * Script: { pasos: Paso[], resultado?: string, estructurado?: unknown, error?: { status, code, mensaje }, salir_con?: number }
 * Paso:   { escribir: { ruta, contenido } } | { borrar: ruta } | { texto: string } | { esperar_ms: number } | { segundo_plano: string }
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

type Step =
  | { escribir: { ruta: string; contenido: string } }
  | { borrar: string }
  | { texto: string }
  | { esperar_ms: number }
  | { segundo_plano: string };

type Script = {
  pasos: Step[];
  resultado?: string;
  estructurado?: unknown;
  error?: { status: number; code: string; mensaje: string };
  salir_con?: number;
};

const [scriptPath, model = 'simulado'] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath!, 'utf8')) as Script;
const sessionId = randomUUID();
const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c: string) => (prompt += c));
process.stdin.on('end', () => void run());
if (process.stdin.isTTY) void run();

async function run() {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), tools: ['Read', 'Edit', 'Write', 'Bash'] });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: `Recibí ${prompt.length} caracteres de instrucciones.` }] } });
  for (const step of script.pasos) {
    if ('escribir' in step) {
      const path = resolve(process.cwd(), step.escribir.ruta);
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: step.escribir.ruta } }] } });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.escribir.contenido);
    } else if ('borrar' in step) {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `rm ${step.borrar}` } }] } });
      rmSync(resolve(process.cwd(), step.borrar), { force: true });
    } else if ('texto' in step) {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: step.texto }] } });
    } else if ('esperar_ms' in step) {
      await new Promise((r) => setTimeout(r, step.esperar_ms));
    } else if ('segundo_plano' in step) {
      emit({ type: 'system', subtype: 'task_started', is_backgrounded: true, description: step.segundo_plano });
    }
  }
  const usage = { input_tokens: 100 + Math.round(prompt.length / 4), output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (script.error) {
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: script.error.status, api_error_code: script.error.code, result: script.error.mensaje, session_id: sessionId, usage, total_cost_usd: 0 });
  } else {
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: script.resultado ?? 'Listo.',
      ...(script.estructurado !== undefined ? { structured_output: script.estructurado } : {}),
      session_id: sessionId,
      usage,
      total_cost_usd: 0,
    });
  }
  process.exit(script.salir_con ?? 0);
}
