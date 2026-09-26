import { describe, expect, it } from 'vitest';
import { windowsSandboxPlan } from '../../src/runtime/windows-sandbox.js';

const spec = {
  workspace: 'C:\\Users\\ana\\.forja\\proyectos\\p\\tareas\\T-001',
  home: 'C:\\Users\\ana\\AppData\\Local\\Temp\\forja-home-1',
  mounts: [{ src: 'C:\\Users\\ana\\.forja\\proveedores\\claude', dest: '/run/forja-home-1/.claude', rw: true }],
  readOnly: ['C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code'],
  proxySocket: '\\\\.\\pipe\\forja-proxy-1',
  helperDir: 'C:\\Users\\ana\\.forja\\app\\helpers',
};

describe('plan de aislamiento en Windows (prototipo)', () => {
  it('concede sólo el espacio de la tarea, el HOME falso, los mounts y las ayudas', () => {
    const plan = windowsSandboxPlan(spec, 'C:\\Users\\ana');
    expect(plan.grants).toContainEqual({ path: spec.workspace, rw: true });
    expect(plan.grants).toContainEqual({ path: spec.home, rw: true });
    expect(plan.grants).toContainEqual({ path: spec.helperDir, rw: false });
    expect(plan.grants).toContainEqual({ path: spec.mounts[0]!.src, rw: true });
    expect(plan.grants).toContainEqual({ path: spec.readOnly[0]!, rw: false });
    expect(plan.grants.some((g) => g.path === 'C:\\Users\\ana')).toBe(false);
  });

  it('un espacio de sólo lectura se concede sin escritura', () => {
    const plan = windowsSandboxPlan({ ...spec, workspaceReadOnly: true }, 'C:\\Users\\ana');
    expect(plan.grants).toContainEqual({ path: spec.workspace, rw: false });
    expect(plan.grants).not.toContainEqual({ path: spec.workspace, rw: true });
  });

  it('pide denegar en lectura el HOME real y dice qué garantías no puede dar', () => {
    const plan = windowsSandboxPlan(spec, 'C:\\Users\\ana');
    expect(plan.denyReadPaths).toEqual(['C:\\Users\\ana']);
    const text = plan.limitations.join('\n');
    expect(text).toMatch(/CREATE_BREAKAWAY_FROM_JOB/);
    expect(text).toMatch(/no lectura/);
    expect(text).toMatch(/WFP/);
    expect(text).toContain(`no se puede montar ${spec.mounts[0]!.src} en ${spec.mounts[0]!.dest}`);
  });

  it('cada lanzamiento tiene un profileId único; el env trae las rutas reales', () => {
    const a = windowsSandboxPlan(spec, 'C:\\Users\\ana');
    const b = windowsSandboxPlan(spec, 'C:\\Users\\ana');
    expect(a.profileId).not.toEqual(b.profileId);
    expect(a.profileId).toMatch(/^forja-/);
    expect(a.env).toEqual({ FORJA_HELPER_DIR: spec.helperDir, FORJA_PROXY_SOCKET: spec.proxySocket });
  });

  it('sin socket de proxy el env no trae la ruta del proxy', () => {
    const { proxySocket: _omit, ...offline } = spec;
    const plan = windowsSandboxPlan(offline, 'C:\\Users\\ana');
    expect(plan.env.FORJA_PROXY_SOCKET).toBeUndefined();
    expect(plan.limitations.join('\n')).not.toContain(spec.proxySocket);
  });
});
