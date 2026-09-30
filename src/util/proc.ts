import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * Process helpers that behave the same on Linux, macOS and Windows (ligera/PLAN.md F1).
 * Windows has no process groups nor SIGTERM, and its CLIs installed with npm are
 * `.cmd` shims that Node refuses to spawn without a shell: here they are resolved to
 * the real script so nothing ever goes through `cmd.exe` string parsing.
 */

/** Kills a process and everything it started. Never throws: the process may be gone. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM', platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    // A detached child leads its own group: the negative pid reaches the whole tree.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Whether a pid exists (signal 0 only checks; on Windows it does not kill). */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The script an npm `.cmd` shim runs, e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`
 * (cmd-shim) or npm's own `npm.cmd`/`npx.cmd`. Null when it is not a Node shim.
 */
export function shimTarget(cmdPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const dir = dirname(cmdPath);
  const m = /"%(?:~dp0|dp0)%\\?([^"]+?\.(?:c|m)?js)"/i.exec(text);
  if (m) {
    const target = resolve(dir, m[1]!.replace(/\\/g, '/'));
    if (existsSync(target)) return target;
  }
  // npm.cmd / npx.cmd look for node_modules\npm\bin\<name>-cli.js next to themselves.
  const name = /([^\\/]+)\.cmd$/i.exec(cmdPath)?.[1]?.toLowerCase();
  if (name === 'npm' || name === 'npx') {
    const cli = join(dir, 'node_modules', 'npm', 'bin', `${name}-cli.js`);
    if (existsSync(cli)) return cli;
  }
  return null;
}

/**
 * Absolute path of a command found in PATH. On Windows it honours PATHEXT, prefers
 * real executables, and turns a Node `.cmd` shim into its `.js` script (run it with
 * `commandArgv`). A shim that is not Node's is returned as is: `commandArgv` wraps it
 * in `cmd.exe /d /c`.
 */
export function resolveCommand(name: string, pathEnv = process.env.PATH ?? process.env.Path ?? '', platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform !== 'win32') {
    for (const dir of pathEnv.split(delimiter)) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return realpathSync(candidate);
    }
    return null;
  }
  const hasExt = /\.[a-z0-9]+$/i.test(name);
  const exts = hasExt
    ? ['']
    : [
        '.exe',
        '.cmd',
        '.bat',
        '.com',
        ...(env.PATHEXT ?? '')
          .toLowerCase()
          .split(';')
          .filter((e) => e && !['.exe', '.cmd', '.bat', '.com'].includes(e)),
      ];
  for (const dir of pathEnv.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (!existsSync(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) return shimTarget(candidate) ?? candidate;
      return candidate;
    }
  }
  return null;
}

/** argv prefix to run what `resolveCommand` found. */
export function commandArgv(resolved: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (/\.(c|m)?js$/i.test(resolved)) return [process.execPath, resolved];
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) return [env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', '/d', '/c', resolved];
  return [resolved];
}

/**
 * Where a local socket for `name` lives: a unix socket inside `dir`, or on Windows a
 * named pipe (Node's `net` takes both as a path). Windows pipes need no cleanup.
 */
export function localSocketPath(dir: string, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return join(dir, name);
  const tag = `${dir}|${name}`.replace(/[^A-Za-z0-9]/g, '').slice(-40);
  return `\\\\.\\pipe\\forja-${tag}-${hashShort(`${dir}|${name}`)}`;
}

function hashShort(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/**
 * `spawn` for a CLI found in PATH, the same on every OS: on Windows a `.cmd` shim runs
 * through node (or cmd.exe as a last resort) and no console window opens.
 */
export function spawnCommand(name: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = process.platform === 'win32' ? resolveCommand(name) : null;
  const [file, ...pre] = resolved ? commandArgv(resolved) : [name];
  return spawn(file!, [...pre, ...args], { windowsHide: true, ...options });
}
