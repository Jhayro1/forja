import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OwnerAuth } from '../../src/api/owner-auth.js';
import { ApiServer } from '../../src/api/server.js';
import { ROOT } from '../helpers/engine.js';

const OWNER = 'dueno@ejemplo.com';
const PANEL = join(ROOT, 'panel', 'dist');

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe('modo servidor: todo detrás del login del dueño', () => {
  let server: ApiServer;
  let port: number;
  let codes: string[];
  let base: string;

  const call = (method: string, path: string, opts: { body?: object; cookie?: string; csrf?: string; host?: string; origin?: string | null } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const payload = opts.body ? JSON.stringify(opts.body) : undefined;
      const headers: Record<string, string> = { Host: opts.host ?? `localhost:${port}` };
      if (payload) headers['Content-Type'] = 'application/json';
      if (opts.origin !== null && method !== 'GET') headers.Origin = opts.origin ?? base;
      if (opts.cookie) headers.Cookie = opts.cookie;
      if (opts.csrf) headers['X-Forja-CSRF'] = opts.csrf;
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  const cookieOf = (r: Res) => String((r.headers['set-cookie'] as string[] | undefined)?.[0] ?? '').split(';')[0]!;

  beforeEach(async () => {
    port = await freePort();
    base = `http://localhost:${port}`;
    codes = [];
    const home = mkdtempSync(join(tmpdir(), 'forja-servidor-'));
    const auth = new OwnerAuth(home, OWNER, async (_to, _purpose, code) => {
      codes.push(code);
      return 'registro';
    });
    server = new ApiServer({ host: '127.0.0.1', port, server: { auth, publicUrl: base } });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it('sin sesión: la raíz y cualquier página van a /login, la API responde 401 y /salud sí contesta', async () => {
    expect((await call('GET', '/salud', { host: 'otro:1' })).status).toBe(200);
    const root = await call('GET', '/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/login');
    expect((await call('GET', '/escritorio')).status).toBe(302);
    expect((await call('GET', '/v1/estado')).status).toBe(401);
    expect((await call('GET', '/v1/modulos')).status).toBe(401);
    expect((await call('GET', '/v1/eventos')).status).toBe(401);
    expect((await call('GET', '/v1/sesion')).status).toBe(401);
    // El intercambio de código del modo local tampoco responde sin sesión.
    expect((await call('POST', '/v1/sesion', { body: { codigo: 'x' } })).status).toBe(401);
  });

  it.skipIf(!existsSync(join(PANEL, '.vite', 'manifest.json')))('sin sesión sólo se sirven los archivos del login, nunca los del panel', async () => {
    const manifest = JSON.parse(readFileSync(join(PANEL, '.vite', 'manifest.json'), 'utf8')) as Record<string, { file: string }>;
    const login = await call('GET', '/login');
    expect(login.status).toBe(200);
    expect(login.headers['content-security-policy']).toMatch(/nonce-/);
    expect((await call('GET', `/${manifest['login.html']!.file}`)).status).toBe(200);
    const panel = await call('GET', `/${manifest['index.html']!.file}`);
    expect(panel.status).toBe(302);
  });

  it('otro Host u Origin se rechaza', async () => {
    expect((await call('GET', '/v1/auth/estado', { host: 'evil.com' })).status).toBe(421);
    expect((await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'x' }, origin: 'http://evil.com' })).status).toBe(403);
    expect((await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'x' }, origin: null })).status).toBe(403);
  });

  it('registro cerrado para cualquier correo que no sea el del dueño', async () => {
    const r = await call('POST', '/v1/auth/registro', { body: { email: 'intruso@ejemplo.com', clave: 'una-clave-larga' } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error.codigo).toBe('registro_cerrado');
    expect(codes).toHaveLength(0);
  });

  it('el dueño se registra, verifica, entra, ve el panel y sale; después el registro queda cerrado', async () => {
    expect(JSON.parse((await call('GET', '/v1/auth/estado')).body)).toMatchObject({ registro_abierto: true, sesion: false });
    expect((await call('POST', '/v1/auth/registro', { body: { email: 'DUENO@ejemplo.com', clave: 'corta' } })).status).toBe(422);
    expect((await call('POST', '/v1/auth/registro', { body: { email: 'DUENO@ejemplo.com', clave: 'una-clave-larga' } })).status).toBe(200);
    expect(codes).toHaveLength(1);
    // Sin verificar no entra.
    expect((await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'una-clave-larga' } })).status).toBe(403);
    expect((await call('POST', '/v1/auth/verificar', { body: { email: OWNER, codigo: '000000' === codes[0] ? '111111' : '000000' } })).status).toBe(400);
    expect((await call('POST', '/v1/auth/verificar', { body: { email: OWNER, codigo: codes[0] } })).status).toBe(200);

    const login = await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'una-clave-larga' } });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    expect(cookie).toMatch(/^forja_sesion=/);
    const { csrf } = JSON.parse(login.body) as { csrf: string };
    const ses = await call('GET', '/v1/sesion', { cookie });
    expect(JSON.parse(ses.body)).toMatchObject({ csrf, servidor: true });
    expect((await call('GET', '/login', { cookie })).status).toBe(302);

    expect(JSON.parse((await call('GET', '/v1/auth/estado')).body).registro_abierto).toBe(false);
    expect((await call('POST', '/v1/auth/registro', { body: { email: OWNER, clave: 'otra-clave-larga' } })).status).toBe(403);

    expect((await call('POST', '/v1/auth/salir', { cookie, body: {} })).status).toBe(403);
    expect((await call('POST', '/v1/auth/salir', { cookie, csrf, body: {} })).status).toBe(200);
    expect((await call('GET', '/v1/sesion', { cookie })).status).toBe(401);
  });

  it('bloquea la cuenta tras 5 contraseñas incorrectas', async () => {
    await call('POST', '/v1/auth/registro', { body: { email: OWNER, clave: 'una-clave-larga' } });
    await call('POST', '/v1/auth/verificar', { body: { email: OWNER, codigo: codes[0] } });
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'mala-mala-mala' } })).status).toBe(401);
    const locked = await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'una-clave-larga' } });
    expect(locked.status).toBe(423);
  });

  it('recupera la contraseña con un código y cierra las sesiones anteriores', async () => {
    await call('POST', '/v1/auth/registro', { body: { email: OWNER, clave: 'una-clave-larga' } });
    await call('POST', '/v1/auth/verificar', { body: { email: OWNER, codigo: codes[0] } });
    const cookie = cookieOf(await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'una-clave-larga' } }));
    expect((await call('POST', '/v1/auth/recuperar', { body: { email: 'otro@ejemplo.com' } })).status).toBe(200);
    expect(codes).toHaveLength(1);
    await call('POST', '/v1/auth/recuperar', { body: { email: OWNER } });
    expect(codes).toHaveLength(2);
    expect((await call('POST', '/v1/auth/recuperar/confirmar', { body: { email: OWNER, codigo: codes[1], clave: 'clave-nueva-larga' } })).status).toBe(200);
    expect((await call('GET', '/v1/sesion', { cookie })).status).toBe(401);
    expect((await call('POST', '/v1/auth/entrar', { body: { email: OWNER, clave: 'clave-nueva-larga' } })).status).toBe(200);
  });
});
