import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptLocal, encryptLocal, MailService, type MailSettings, type Message } from '../../src/notify/mail.js';
import { mailOnce, mailPending } from '../../src/notify/mail-notices.js';
import { EventStore } from '../../src/store/event-store.js';

const base = {
  activo: true,
  host: 'mail.ejemplo.com',
  puerto: 587,
  seguridad: 'starttls' as const,
  usuario: 'noreply@ejemplo.com',
  clave: 'clave-de-aplicacion',
  remitente: 'noreply@ejemplo.com',
  nombre_remitente: 'Forja',
  destinatario: 'dueno@ejemplo.com',
  avisos: { chat: false },
};

function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'forja-correo-'));
  const sent: { settings: MailSettings; message: Message }[] = [];
  const mail = new MailService(home, env, async (settings, message) => {
    sent.push({ settings, message });
  });
  return { home, mail, sent };
}

describe('correo SMTP', () => {
  it('guarda la clave cifrada y nunca la devuelve', () => {
    const { home, mail } = setup();
    const view = mail.save(base);
    expect(view.clave_guardada).toBe(true);
    expect(JSON.stringify(view)).not.toContain('clave-de-aplicacion');
    expect(readFileSync(join(home, 'correo.json'), 'utf8')).not.toContain('clave-de-aplicacion');
    expect(mail.settings()?.clave).toBe('clave-de-aplicacion');
    // Guardar sin clave conserva la anterior.
    mail.save({ ...base, clave: '', puerto: 465, seguridad: 'tls' });
    expect(mail.settings()).toMatchObject({ clave: 'clave-de-aplicacion', puerto: 465, seguridad: 'tls' });
  });

  it('rechaza datos inválidos con un mensaje claro', () => {
    const { mail } = setup();
    expect(() => mail.save({ ...base, destinatario: 'no-es-correo' })).toThrow(/destinatario/);
  });

  it('cifra y descifra con la clave local', () => {
    const { home } = setup();
    const sealed = encryptLocal(home, 'secreto');
    expect(sealed).not.toContain('secreto');
    expect(decryptLocal(home, sealed)).toBe('secreto');
  });

  it('las variables FORJA_SMTP_* mandan y no se pueden sobrescribir desde el panel', () => {
    const { mail } = setup({ FORJA_SMTP_HOST: 'smtp.env', FORJA_SMTP_USER: 'u@env.com', FORJA_SMTP_PASSWORD: 'p', FORJA_SMTP_TO: 'd@env.com' });
    expect(mail.view()).toMatchObject({ host: 'smtp.env', desde_entorno: true, clave_guardada: true, puerto: 587, seguridad: 'starttls' });
    expect(() => mail.save(base)).toThrow(/variables/);
  });

  it('respeta los tipos de aviso desactivados y envía la prueba', async () => {
    const { mail, sent } = setup();
    mail.save(base);
    expect(mail.wants('chat')).toBe(false);
    expect(mail.wants('trabajos')).toBe(true);
    expect(await mail.notice('chat', { asunto: 'x', texto: 'y' })).toBe(false);
    await mail.test();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settings.destinatario).toBe('dueno@ejemplo.com');
  });

  it('un aviso con la misma clave sale una sola vez, aunque se reinicie el proceso', async () => {
    const { home, mail, sent } = setup();
    mail.save(base);
    const store = EventStore.open(join(home, 'forja.db'), 'chk_prueba');
    expect(await mailOnce(store, mail, 'trabajos', 'k1', { asunto: 'a', texto: 'b' })).toBe(true);
    expect(await mailOnce(store, mail, 'trabajos', 'k1', { asunto: 'a', texto: 'b' })).toBe(false);
    const pending = [{ kind: 'pregunta_tarea' as const, id: 'T-001', text: '¿Qué formato?', action: 'responde' }];
    expect(await mailPending(store, mail, 'demo', pending)).toBe(1);
    expect(await mailPending(store, mail, 'demo', pending)).toBe(0);
    expect(await mailPending(store, mail, 'demo', [{ ...pending[0]!, text: 'Otra pregunta' }])).toBe(1);
    expect(sent.map((s) => s.message.asunto)).toEqual(['a', 'Forja · demo: T-001 espera tu respuesta', 'Forja · demo: T-001 espera tu respuesta']);
    store.close();
  });
});
