import { execFile } from 'node:child_process';
import { isWsl } from '../registry/paths.js';

export type Opener = { file: string; args: string[] };

/** Only the panel's own local link: nothing else is ever handed to a shell. */
const PANEL_LINK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/(#codigo=[\w-]+)?$/;

/**
 * How to open the user's browser, in order of preference. On WSL it is the
 * Windows browser: `wslview` (wslu) or PowerShell's Start-Process, both of which
 * keep the `#codigo=…` fragment that logs the panel in.
 */
export function browserCommands(url: string, platform: NodeJS.Platform = process.platform, wsl: boolean = isWsl()): Opener[] {
  if (!PANEL_LINK.test(url)) throw new Error('enlace del panel inválido');
  if (wsl)
    return [
      { file: 'wslview', args: [url] },
      { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`] },
    ];
  if (platform === 'darwin') return [{ file: 'open', args: [url] }];
  if (platform === 'win32') return [{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`] }];
  return [{ file: 'xdg-open', args: [url] }];
}

export type Runner = (file: string, args: string[]) => Promise<boolean>;

const run: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000 }, (error) => resolve(!error));
  });

/** Tries each way to open the link; false when none worked (the caller prints it instead). */
export async function openBrowser(url: string, runner: Runner = run, commands: Opener[] = browserCommands(url)): Promise<boolean> {
  for (const c of commands) if (await runner(c.file, c.args)) return true;
  return false;
}
