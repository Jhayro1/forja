import { existsSync, readFileSync } from 'node:fs';

/** Whether this Linux is WSL (Windows drives are mounted under /mnt/<letter>). */
export function isWsl(readProcVersion: () => string = () => readFileSync('/proc/version', 'utf8')): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(readProcVersion());
  } catch {
    return false;
  }
}

/**
 * A path as the user typed or pasted it, as a Linux path. Accepts Windows paths
 * (`C:\Users\x`, `C:/Users/x`, "Copy as path" with quotes) and WSL network paths
 * (`\\wsl.localhost\Ubuntu\home\x`, `\\wsl$\Ubuntu\home\x`); anything else is
 * returned trimmed, unchanged.
 */
export function fromUserPath(input: string, platform: NodeJS.Platform = process.platform): string {
  const text = input.trim().replace(/^["']|["']$/g, '');
  // Native Windows (ligera edition): a Windows path is already the right path.
  if (platform === 'win32') return text;
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(text);
  if (drive) {
    const rest = drive[2]!.replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(text);
  if (unc) return (unc[1] ?? '\\').replace(/\\/g, '/');
  return text;
}

/** The Windows spelling of a WSL path under /mnt/<letter>, for display; null otherwise. */
export function toWindowsPath(path: string): string | null {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(path);
  if (!m) return null;
  return `${m[1]!.toUpperCase()}:${(m[2] ?? '\\').replace(/\//g, '\\')}`;
}

/** Folders the panel may browse: your Linux HOME and, on WSL, your Windows user folder. */
export function browseRoots(home: string, winUsers = '/mnt/c/Users'): string[] {
  const roots = [home];
  if (existsSync(winUsers)) roots.push(winUsers);
  return roots;
}
