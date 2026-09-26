import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchOrder } from '../runtime/order.js';
import { binaryBinds, type Mount } from '../runtime/sandbox.js';
import { activeSandboxMode } from '../runtime/sandbox-mode.js';
import { buildAgentEnv } from '../security/env.js';
import type { ProviderKind } from './stream.js';

export type ToolProfile = 'lectura' | 'edicion';

export type LaunchParams = {
  launchId: string;
  fencingToken: number;
  runId: string;
  taskId: string;
  attempt: number;
  model: string;
  prompt: string;
  /** The only writable project directory for the agent. */
  workspace: string;
  /** Persistent per-checkout directory for this provider's sessions (enables resume). */
  providerStateDir: string;
  /** Private launch input directory (schema, simulator script), mounted read-only. */
  inputsDir: string;
  tools: ToolProfile;
  /** Mount the workspace read-only (planner, reviewer). */
  workspaceReadOnly?: boolean;
  /** Extra hosts beyond the provider API (e.g. a package registry for an install task). */
  extraHosts?: string[];
  outputSchema?: object;
  resumeSessionId?: string;
  timeoutMs: number;
  extraMounts?: Mount[];
  /** Only for the simulated provider. */
  simulationScript?: object;
  /** Host path of this launch's MCP gateway socket (M5): the agent's ONLY MCP server. */
  mcpSocket?: string;
};

/**
 * Where the gateway socket and its stdio bridge appear inside the sandbox. The
 * socket's FOLDER is mounted (not the socket file), so a gateway recreated at
 * the same path after `forja run` restarts is visible to a running agent.
 */
const MCP_DIR_IN_SANDBOX = '/run/forja-mcp';
export const MCP_SOCKET_NAME = 'p.sock';
export const MCP_SOCKET_IN_SANDBOX = `${MCP_DIR_IN_SANDBOX}/${MCP_SOCKET_NAME}`;
const MCP_BIN_IN_SANDBOX = '/run/forja-mcp-bin';
const MCP_BIN_DIR = fileURLToPath(new URL('../mcp/', import.meta.url));

function mcpSocketMount(socket: string): Mount {
  if (basename(socket) !== MCP_SOCKET_NAME) throw new AdapterError(`el socket del gateway debe llamarse ${MCP_SOCKET_NAME}`);
  return { src: dirname(socket), dest: MCP_DIR_IN_SANDBOX, rw: true };
}

function gatewayMounts(p: LaunchParams): Mount[] {
  return p.mcpSocket ? [mcpSocketMount(p.mcpSocket), { src: MCP_BIN_DIR, dest: MCP_BIN_IN_SANDBOX, rw: false }] : [];
}

/** stdio MCP server definition that reaches the gateway through the mounted socket. */
export function gatewayServer(): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(MCP_BIN_IN_SANDBOX, 'bridge-main.js'), MCP_SOCKET_IN_SANDBOX] };
}

export interface ProviderAdapter {
  readonly id: 'claude' | 'codex' | 'simulado';
  /** Which parser reads this provider's stdout. */
  readonly parser: ProviderKind;
  buildOrder(params: LaunchParams): LaunchOrder;
}

export class AdapterError extends Error {}

const SANDBOX_HOME = homedir();
const STATE_IN_SANDBOX = join(SANDBOX_HOME, '.forja-proveedor');
const INPUTS_IN_SANDBOX = '/run/forja-entrada';

export function resolveExecutable(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

function baseEnv(extra: Record<string, string>): Record<string, string> {
  return buildAgentEnv(process.env, { home: SANDBOX_HOME, tmpdir: '/tmp', extra });
}

function commonMounts(p: LaunchParams, credentialFile: string, credentialName: string): Mount[] {
  mkdirSync(p.providerStateDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.inputsDir, { recursive: true, mode: 0o700 });
  return [
    { src: p.providerStateDir, dest: STATE_IN_SANDBOX, rw: true },
    // Only the credential file of THIS provider is visible (D2-21); rw because the CLI refreshes it.
    { src: credentialFile, dest: join(STATE_IN_SANDBOX, credentialName), rw: true },
    { src: p.inputsDir, dest: INPUTS_IN_SANDBOX, rw: false },
    ...gatewayMounts(p),
    ...(p.extraMounts ?? []),
  ];
}

function common(p: LaunchParams): Pick<LaunchOrder, 'protocol_version' | 'launch_id' | 'fencing_token' | 'run_id' | 'task_id' | 'attempt' | 'cwd' | 'timeout_ms' | 'kill_grace_ms' | 'stdin_text'> {
  return {
    protocol_version: 1,
    launch_id: p.launchId,
    fencing_token: p.fencingToken,
    run_id: p.runId,
    task_id: p.taskId,
    attempt: p.attempt,
    cwd: p.workspace,
    timeout_ms: p.timeoutMs,
    kill_grace_ms: 5000,
    stdin_text: p.prompt,
  };
}

/** Claude Code, launch profile from m0/RESULTADOS.md. */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly parser = 'claude' as const;
  static readonly HOSTS = ['api.anthropic.com', 'console.anthropic.com', 'platform.claude.com', 'claude.ai'];

  constructor(private readonly executable = resolveExecutable('claude')) {}

  static credentialFile(): string {
    return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  }

  buildOrder(p: LaunchParams): LaunchOrder {
    if (!this.executable) throw new AdapterError('Claude Code no está instalado (no se encontró «claude» en el PATH)');
    const cred = ClaudeAdapter.credentialFile();
    if (!existsSync(cred)) throw new AdapterError(`no se encontró la sesión de Claude (${cred}); ejecuta «claude» e inicia sesión`);
    const tools = p.tools === 'edicion' ? ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] : ['Read', 'Glob', 'Grep'];
    const argv = [
      this.executable,
      '-p',
      '--model',
      p.model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--tools',
      tools.join(','),
      '--allowedTools',
      [...tools, ...(p.mcpSocket ? ['mcp__forja'] : [])].join(','),
      // M0 finding 1: never inherit the user's MCP servers; the only one allowed is Forja's gateway.
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: p.mcpSocket ? { forja: gatewayServer() } : {} }),
      // M0 finding 2: no user settings, plugins or global memory.
      '--setting-sources',
      'project,local',
      '--disable-slash-commands',
    ];
    if (p.outputSchema) argv.push('--json-schema', JSON.stringify(p.outputSchema));
    if (p.resumeSessionId) argv.push('--resume', p.resumeSessionId);
    return {
      ...common(p),
      provider: 'claude',
      argv,
      env: baseEnv({
        CLAUDE_CONFIG_DIR: STATE_IN_SANDBOX,
        // M0 finding 3: background work produced a false success.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
      }),
      sandbox: {
        mode: activeSandboxMode(),
        home: SANDBOX_HOME,
        mounts: commonMounts(p, cred, '.credentials.json'),
        read_only: binaryBinds([this.executable, process.execPath]),
        network_hosts: [...ClaudeAdapter.HOSTS, ...(p.extraHosts ?? [])],
        workspace_read_only: p.workspaceReadOnly ?? false,
      },
      redact_files: [cred],
    };
  }
}

/** Codex CLI, launch profile from m0/RESULTADOS.md. */
export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly parser = 'codex' as const;
  static readonly HOSTS = ['chatgpt.com', 'api.openai.com', 'auth.openai.com'];

  constructor(private readonly executable = resolveExecutable('codex')) {}

  static credentialFile(): string {
    return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  }

  buildOrder(p: LaunchParams): LaunchOrder {
    if (!this.executable) throw new AdapterError('Codex no está instalado (no se encontró «codex» en el PATH)');
    const cred = CodexAdapter.credentialFile();
    if (!existsSync(cred)) throw new AdapterError(`no se encontró la sesión de Codex (${cred}); ejecuta «codex login»`);
    const sandbox = p.tools === 'edicion' ? 'workspace-write' : 'read-only';
    const flags = ['--json', '--ignore-user-config', '--skip-git-repo-check', '-m', p.model];
    if (p.mcpSocket) {
      const gw = gatewayServer();
      flags.push('-c', `mcp_servers.forja.command=${JSON.stringify(gw.command)}`, '-c', `mcp_servers.forja.args=${JSON.stringify(gw.args)}`);
    }
    let argv: string[];
    if (p.resumeSessionId) {
      // `exec resume` does not accept -s: the policy is set through config (verified in M0).
      argv = [this.executable, 'exec', 'resume', ...flags, '-c', `sandbox_mode="${sandbox}"`, p.resumeSessionId, '-'];
    } else {
      argv = [this.executable, 'exec', ...flags, '-s', sandbox, '-C', p.workspace];
      if (p.outputSchema) {
        mkdirSync(p.inputsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(p.inputsDir, 'esquema.json'), JSON.stringify(p.outputSchema), { mode: 0o600 });
        argv.push('--output-schema', join(INPUTS_IN_SANDBOX, 'esquema.json'));
      }
      argv.push('-');
    }
    return {
      ...common(p),
      provider: 'codex',
      argv,
      env: baseEnv({ CODEX_HOME: STATE_IN_SANDBOX }),
      sandbox: {
        mode: activeSandboxMode(),
        home: SANDBOX_HOME,
        mounts: commonMounts(p, cred, 'auth.json'),
        read_only: binaryBinds([this.executable, process.execPath]),
        network_hosts: [...CodexAdapter.HOSTS, ...(p.extraHosts ?? [])],
        workspace_read_only: p.workspaceReadOnly ?? false,
      },
      redact_files: [cred],
    };
  }
}

/**
 * Simulated provider: a scripted agent that really edits files inside the same
 * sandbox and speaks Claude's stream-json. Used for tests and demos without quota.
 */
export class SimulatedAdapter implements ProviderAdapter {
  readonly id = 'simulado' as const;
  readonly parser = 'claude' as const;

  /** `agentDir`: folder containing the compiled sim-agent.js (defaults to this module's folder). */
  constructor(private readonly options: { sandbox?: boolean; agentDir?: string } = {}) {}

  buildOrder(p: LaunchParams): LaunchOrder {
    mkdirSync(p.inputsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(p.inputsDir, 'guion.json'), JSON.stringify(p.simulationScript ?? { pasos: [], resultado: 'OK' }), { mode: 0o600 });
    const sandboxed = this.options.sandbox ?? true;
    const scriptInside = sandboxed ? join(INPUTS_IN_SANDBOX, 'guion.json') : join(p.inputsDir, 'guion.json');
    const helperDir = this.options.agentDir ?? fileURLToPath(new URL('.', import.meta.url));
    const argv = [process.execPath, sandboxed ? join('/run/forja-sim', 'sim-agent.js') : join(helperDir, 'sim-agent.js'), scriptInside, p.model];
    return {
      ...common(p),
      provider: 'simulado',
      argv,
      env: baseEnv(p.mcpSocket ? { MCP_PASARELA: sandboxed ? MCP_SOCKET_IN_SANDBOX : p.mcpSocket } : {}),
      sandbox: sandboxed
        ? {
            mode: activeSandboxMode(),
            home: SANDBOX_HOME,
            mounts: [
              { src: p.inputsDir, dest: INPUTS_IN_SANDBOX, rw: false },
              { src: helperDir, dest: '/run/forja-sim', rw: false },
              ...(p.mcpSocket ? [mcpSocketMount(p.mcpSocket)] : []),
              ...(p.extraMounts ?? []),
            ],
            read_only: binaryBinds([process.execPath]),
            network_hosts: [],
            workspace_read_only: p.workspaceReadOnly ?? false,
          }
        : { mode: 'ninguno' },
      redact_files: [],
    };
  }
}
