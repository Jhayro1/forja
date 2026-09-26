import { describe, expect, it } from 'vitest';
import { browserCommands, openBrowser } from '../../src/cli/open-browser.js';

const URL = 'http://127.0.0.1:7788/#codigo=abc_DEF-123';

describe('abrir el navegador con el panel', () => {
  it('en WSL abre el navegador de Windows conservando el código del enlace', () => {
    const cmds = browserCommands(URL, 'linux', true);
    expect(cmds.map((c) => c.file)).toEqual(['wslview', 'powershell.exe']);
    expect(cmds[1]!.args.at(-1)).toBe(`Start-Process '${URL}'`);
  });

  it('en Linux, macOS y Windows usa lo propio de cada uno', () => {
    expect(browserCommands(URL, 'linux', false)).toEqual([{ file: 'xdg-open', args: [URL] }]);
    expect(browserCommands(URL, 'darwin', false)).toEqual([{ file: 'open', args: [URL] }]);
    expect(browserCommands(URL, 'win32', false)[0]!.file).toBe('powershell.exe');
  });

  it('sólo acepta el enlace local del panel (nada que se pueda colar en un comando)', () => {
    for (const bad of ["http://127.0.0.1:1/#codigo=x';calc;'", 'https://evil.example/', 'http://127.0.0.1:1/#codigo=a b', 'file:///etc/passwd']) {
      expect(() => browserCommands(bad, 'linux', true)).toThrow(/inválido/);
    }
  });

  it('prueba en orden y avisa si ninguno funcionó', async () => {
    const tried: string[] = [];
    const cmds = browserCommands(URL, 'linux', true);
    expect(
      await openBrowser(
        URL,
        async (f) => {
          tried.push(f);
          return f === 'powershell.exe';
        },
        cmds,
      ),
    ).toBe(true);
    expect(tried).toEqual(['wslview', 'powershell.exe']);
    expect(await openBrowser(URL, async () => false, cmds)).toBe(false);
  });
});
