import { afterEach, describe, expect, it } from 'vitest';
import { ProviderLogins } from '../../src/cli/provider-login.js';

const node = process.execPath;
// Imitan lo medido en F0: Claude imprime el enlace y espera el código por stdin; Codex termina solo.
const claudeLike = `console.log('Opening browser to sign in');console.log('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1');process.stdout.write('Paste code here if prompted > ');process.stdin.once('data', d => process.exit(d.toString().trim() === 'abc123#estado' ? 0 : 1));`;
const codexLike = `console.log('Starting local login server on http://localhost:1455.');console.log('https://auth.openai.com/oauth/authorize?response_type=code');setTimeout(() => process.exit(0), 200);`;

let logins: ProviderLogins;
afterEach(() => logins?.close());

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('no se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Como el claude real (medido): con un código inválido avisa y sigue esperando otro.
const claudeRetry = `console.log('visit: https://claude.com/cai/oauth/authorize?code=true');process.stdout.write('Paste code here if prompted > ');process.stdin.on('data', d => { if (d.toString().trim() === 'bueno#1') process.exit(0); console.log('Invalid code. Please make sure the full code was copied.'); });`;

describe('inicio de sesión de proveedores desde el panel', () => {
  it('Claude: si el código es inválido lo avisa y deja pegar otro', async () => {
    logins = new ProviderLogins({ claude: { file: node, args: ['-e', claudeRetry], asksCode: true }, codex: { file: node, args: ['-e', codexLike], asksCode: false } });
    logins.start('claude');
    await until(() => logins.get('claude')!.estado === 'esperando');
    logins.submitCode('claude', 'malo123');
    expect(logins.get('claude')!.pide_codigo).toBe(false);
    await until(() => logins.get('claude')!.pide_codigo);
    expect(logins.get('claude')).toMatchObject({ estado: 'esperando', mensaje: 'Invalid code. Please make sure the full code was copied.' });
    logins.submitCode('claude', 'bueno#1');
    await until(() => logins.get('claude')!.estado === 'listo');
  });

  it('Claude: muestra el enlace, recibe el código pegado y termina con sesión', async () => {
    logins = new ProviderLogins({ claude: { file: node, args: ['-e', claudeLike], asksCode: true }, codex: { file: node, args: ['-e', codexLike], asksCode: false } });
    logins.start('claude');
    await until(() => logins.get('claude')!.estado === 'esperando');
    expect(logins.get('claude')).toMatchObject({ url: 'https://claude.com/cai/oauth/authorize?code=true&x=1', pide_codigo: true });
    expect(() => logins.submitCode('claude', 'no válido; rm -rf')).toThrow(/formato/);
    logins.submitCode('claude', '  abc123#estado ');
    await until(() => logins.get('claude')!.estado !== 'esperando');
    expect(logins.get('claude')).toMatchObject({ estado: 'listo', mensaje: 'sesión iniciada' });
  });

  it('Claude: un código equivocado termina en error, con el motivo', async () => {
    logins = new ProviderLogins({ claude: { file: node, args: ['-e', claudeLike], asksCode: true }, codex: { file: node, args: ['-e', codexLike], asksCode: false } });
    logins.start('claude');
    await until(() => logins.get('claude')!.estado === 'esperando');
    logins.submitCode('claude', 'equivocado');
    await until(() => logins.get('claude')!.estado !== 'esperando');
    expect(logins.get('claude')!.estado).toBe('error');
  });

  it('Codex: muestra el enlace y termina solo, sin pedir código', async () => {
    logins = new ProviderLogins({ claude: { file: node, args: ['-e', claudeLike], asksCode: true }, codex: { file: node, args: ['-e', codexLike], asksCode: false } });
    logins.start('codex');
    await until(() => logins.get('codex')!.url !== null);
    expect(logins.get('codex')!.pide_codigo).toBe(false);
    expect(() => logins.submitCode('codex', 'abc123')).toThrow();
    await until(() => logins.get('codex')!.estado === 'listo');
  });

  it('sin el CLI instalado lo dice claro; cancelar corta la espera', async () => {
    logins = new ProviderLogins({
      claude: { file: '/no/existe/claude', args: [], asksCode: true },
      codex: { file: node, args: ['-e', 'setInterval(()=>{},1000);console.log("https://x.y/z")'], asksCode: false },
    });
    logins.start('claude');
    await until(() => logins.get('claude')!.estado === 'error');
    expect(logins.get('claude')!.mensaje).toMatch(/no está instalado/);
    logins.start('codex');
    await until(() => logins.get('codex')!.estado === 'esperando');
    expect(logins.cancel('codex')!.estado).toBe('cancelado');
  });
});
