import { describe, expect, it } from 'vitest';
import { sbplString, seatbeltArgs, seatbeltProfile } from '../../src/runtime/seatbelt.js';

const spec = {
  workspace: '/Users/ana/.forja/proyectos/p/tareas/T-001',
  home: '/private/tmp/forja-home-1',
  mounts: [{ src: '/Users/ana/.forja/proveedores/claude', dest: '/private/tmp/forja-home-1/.claude', rw: true }],
  readOnly: ['/Users/ana/.npm-global/lib/node_modules/@anthropic-ai/claude-code'],
  proxySocket: '/private/tmp/forja-proxy-1.sock',
  helperDir: '/Users/ana/.forja/app/helpers',
};

describe('perfil Seatbelt (prototipo macOS)', () => {
  it('niega por defecto, oculta el HOME real y sólo deja escribir el espacio de la tarea', () => {
    const { profile } = seatbeltProfile(spec, '/Users/ana');
    expect(profile.startsWith('(version 1)\n(deny default)')).toBe(true);
    expect(profile).toContain('(deny file-read* (subpath "/Users/ana"))');
    const write = profile.split('\n').find((l) => l.startsWith('(allow file-write* '))!;
    expect(write).toContain('(subpath "/Users/ana/.forja/proyectos/p/tareas/T-001")');
    expect(write).toContain('(subpath "/Users/ana/.forja/proveedores/claude")');
    expect(write).not.toContain('/Users/ana/.npm-global');
    // The read re-allow comes after the HOME deny: later rules win in SBPL.
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(profile.indexOf('(allow file-read* (subpath'));
  });

  it('sin red salvo el socket del proxy, y dice lo que no puede garantizar', () => {
    const plan = seatbeltProfile(spec, '/Users/ana');
    expect(plan.profile).toContain('(allow network-outbound (remote unix-socket (path-literal "/private/tmp/forja-proxy-1.sock")))');
    expect(plan.profile).not.toContain('(allow network*)');
    expect(plan.env).toEqual({ FORJA_HELPER_DIR: spec.helperDir, FORJA_PROXY_SOCKET: spec.proxySocket });
    expect(plan.limitations.join('\n')).toMatch(/setsid/);
    expect(plan.limitations.join('\n')).toContain('no se puede montar /Users/ana/.forja/proveedores/claude');
  });

  it('un espacio de sólo lectura no se puede escribir; sin proxy hay red como en Linux', () => {
    const { proxySocket: _, ...offline } = spec;
    const { profile } = seatbeltProfile({ ...offline, workspaceReadOnly: true }, '/Users/ana');
    expect(profile.split('\n').find((l) => l.startsWith('(allow file-write* '))).not.toContain('tareas/T-001');
    expect(profile).toContain('(allow network*)');
  });

  it('escapa comillas y barras en las rutas', () => {
    expect(sbplString('/a"b\\c')).toBe('"/a\\"b\\\\c"');
    expect(seatbeltArgs(spec, ['claude', '-p'])).toEqual(['-p', expect.stringContaining('(deny default)'), 'claude', '-p']);
  });
});
