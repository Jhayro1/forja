import { MailError, type MailService } from '../../notify/mail.js';
import { ApiError } from '../http.js';
import type { ApiModule } from '../server.js';

/** SMTP settings for email notices (v3/PLAN.md §6.10), next to providers and models. */
export function mailModule(mail: MailService): ApiModule {
  const guard = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MailError) throw new ApiError(422, 'correo', error.message);
      throw error;
    }
  };
  return {
    name: 'correo',
    routes: [
      { method: 'GET', path: /^\/v1\/correo$/, handler: () => ({ correo: mail.view() }) },
      { method: 'POST', path: /^\/v1\/correo$/, handler: async ({ body }) => ({ ok: true, correo: await guard(async () => mail.save(await body())), mensaje: 'correo guardado' }) },
      {
        method: 'POST',
        path: /^\/v1\/correo\/prueba$/,
        handler: async () => {
          await guard(() => mail.test());
          return { ok: true, mensaje: 'correo de prueba enviado: revisa tu bandeja' };
        },
      },
    ],
  };
}
