import { describe, expect, it } from 'vitest';
import { dockerArgs, dockerLimitations, hostIds } from '../../src/runtime/docker-sandbox.js';

const spec = {
  workspace: '/home/ana/.forja/proyectos/p/tareas/T-001',
  home: '/tmp/forja-home-1',
  mounts: [{ src: '/home/ana/.forja/proveedores/claude', dest: '/home/ana/.forja-proveedor/.credentials.json', rw: true }],
  readOnly: ['/opt/claude-code', '/opt/node22'],
  proxySocket: '/tmp/forja-px-1/p.sock',
  helperDir: '/home/ana/.forja/app/helpers',
};

describe('argumentos de docker run (mismo contrato que bwrap)', () => {
  it('monta el workspace, los mounts, las ayudas y bloquea red salvo el socket del proxy', () => {
    const args = dockerArgs(spec, { FOO: 'bar' });
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--init');
    expect(args).toContain('--read-only');
    expect(args.join(' ')).toContain('--tmpfs /tmp:');
    expect(args.join(' ')).toContain(`-v ${spec.workspace}:${spec.workspace}:rw`);
    expect(args.join(' ')).toContain(`-v ${spec.mounts[0]!.src}:${spec.mounts[0]!.dest}:rw`);
    expect(args.join(' ')).toContain(`-v ${spec.readOnly[0]}:${spec.readOnly[0]}:ro`);
    expect(args.join(' ')).toContain(`-v ${spec.helperDir}:/run/forja:ro`);
    expect(args.join(' ')).toContain(`-v ${spec.proxySocket}:/run/forja-proxy.sock`);
    expect(args).toContain('none');
    expect(args.join(' ')).toContain('-e FOO=bar');
    expect(args.at(-1)).toBe('forja-sandbox:latest');
  });

  it('workspace de sólo lectura no se marca rw', () => {
    const args = dockerArgs({ ...spec, workspaceReadOnly: true });
    expect(args.join(' ')).toContain(`-v ${spec.workspace}:${spec.workspace}:ro`);
  });

  it('sin socket de proxy no agrega --network none (mismo contrato que bwrap sin --unshare-net)', () => {
    const { proxySocket: _omit, ...offline } = spec;
    const args = dockerArgs(offline);
    expect(args).not.toContain('none');
    expect(args.join(' ')).not.toContain('--network');
  });

  it('usa el uid/gid real del host cuando existen', () => {
    const ids = hostIds();
    const args = dockerArgs(spec);
    if (ids) {
      expect(args).toContain('--user');
      expect(args).toContain(`${ids.uid}:${ids.gid}`);
      expect(args.join(' ')).toContain(`uid=${ids.uid},gid=${ids.gid}`);
    } else {
      expect(args).not.toContain('--user');
    }
  });

  it('declara sus límites según si hay uid/gid de host', () => {
    expect(dockerLimitations(true).join('\n')).not.toMatch(/usuario por defecto/);
    expect(dockerLimitations(false).join('\n')).toMatch(/usuario por defecto/);
  });
});
