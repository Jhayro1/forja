import '../index.css';
import { setNonce } from 'get-nonce';
import { ArrowLeftIcon, BotIcon, GitBranchIcon, LoaderCircleIcon, LockKeyholeIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTheme } from '@/hooks/use-theme';

/**
 * Login of server mode (v3/PLAN.md §6.9). It is its own bundle: without a session the
 * server only hands out this page and its files, never the panel.
 */
const nonce = document.querySelector<HTMLMetaElement>('meta[name="forja-nonce"]')?.content;
if (nonce && nonce !== '__FORJA_NONCE__') setNonce(nonce);

type Step = 'entrar' | 'registro' | 'verificar' | 'recuperar' | 'nueva-clave';

async function post(path: string, body: object): Promise<{ mensaje?: string }> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { mensaje?: string; error?: { mensaje?: string } };
  if (!res.ok) throw new Error(data.error?.mensaje ?? `error ${res.status}`);
  return data;
}

function Field({ id, label, children, extra }: { id: string; label: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {extra}
      </div>
      {children}
    </div>
  );
}

function Feature({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="text-sm text-white/70">{text}</span>
      </span>
    </li>
  );
}

function LoginPage() {
  useTheme();
  const [step, setStep] = useState<Step>('entrar');
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    fetch('/v1/auth/estado', { credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ registro_abierto?: boolean; sesion?: boolean }>)
      .then((s) => {
        if (s.sesion) location.replace('/');
        setOpen(Boolean(s.registro_abierto));
      })
      .catch(() => {});
  }, []);

  const go = (next: Step, message: string | null = null) => {
    setStep(next);
    setError(null);
    setInfo(message);
    setCode('');
  };

  const run = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const samePasswords = () => {
    if (password !== password2) throw new Error('las contraseñas no coinciden');
  };

  const title: Record<Step, [string, string]> = {
    entrar: ['Entrar a Forja', 'Sólo el dueño de esta instalación puede entrar.'],
    registro: ['Crear la cuenta del dueño', 'El registro está cerrado para cualquier otro correo.'],
    verificar: ['Verifica tu correo', 'Escribe el código de 6 dígitos que te enviamos.'],
    recuperar: ['Recuperar el acceso', 'Te enviaremos un código al correo del dueño.'],
    'nueva-clave': ['Nueva contraseña', 'Escribe el código que recibiste y tu nueva contraseña.'],
  };

  const emailField = (
    <Field id="email" label="Correo">
      <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" />
    </Field>
  );
  const codeField = (
    <Field id="codigo" label="Código">
      <Input
        id="codigo"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        className="text-center font-mono text-lg tracking-[0.5em]"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
    </Field>
  );
  const newPasswordFields = (
    <>
      <Field id="clave" label="Contraseña">
        <Input id="clave" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field id="clave2" label="Repite la contraseña">
        <Input id="clave2" type="password" autoComplete="new-password" minLength={10} required value={password2} onChange={(e) => setPassword2(e.target.value)} />
      </Field>
      <p className="text-xs text-muted-foreground">Al menos 10 caracteres.</p>
    </>
  );

  let form: ReactNode;
  if (step === 'entrar')
    form = (
      <form
        className="grid gap-4"
        onSubmit={(e) =>
          void run(e, async () => {
            await post('/v1/auth/entrar', { email, clave: password });
            location.replace('/');
          })
        }
      >
        {emailField}
        <Field
          id="clave"
          label="Contraseña"
          extra={
            <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => go('recuperar')}>
              ¿La olvidaste?
            </button>
          }
        >
          <Input id="clave" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <LockKeyholeIcon />} Entrar
        </Button>
      </form>
    );
  else if (step === 'registro')
    form = (
      <form
        className="grid gap-4"
        onSubmit={(e) =>
          void run(e, async () => {
            samePasswords();
            const r = await post('/v1/auth/registro', { email, clave: password });
            go('verificar', r.mensaje ?? null);
          })
        }
      >
        {emailField}
        {newPasswordFields}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? <LoaderCircleIcon className="animate-spin" /> : null} Crear cuenta
        </Button>
      </form>
    );
  else if (step === 'verificar')
    form = (
      <form
        className="grid gap-4"
        onSubmit={(e) =>
          void run(e, async () => {
            const r = await post('/v1/auth/verificar', { email, codigo: code });
            setOpen(false);
            go('entrar', r.mensaje ?? null);
          })
        }
      >
        {emailField}
        {codeField}
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
          Verificar
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={(e) =>
            void run(e, async () => {
              const r = await post('/v1/auth/reenviar', { email });
              setInfo(r.mensaje ?? null);
            })
          }
        >
          Enviar otro código
        </Button>
      </form>
    );
  else if (step === 'recuperar')
    form = (
      <form
        className="grid gap-4"
        onSubmit={(e) =>
          void run(e, async () => {
            const r = await post('/v1/auth/recuperar', { email });
            go('nueva-clave', r.mensaje ?? null);
          })
        }
      >
        {emailField}
        <Button type="submit" disabled={busy} className="w-full">
          Enviar código
        </Button>
      </form>
    );
  else
    form = (
      <form
        className="grid gap-4"
        onSubmit={(e) =>
          void run(e, async () => {
            samePasswords();
            const r = await post('/v1/auth/recuperar/confirmar', { email, codigo: code, clave: password });
            go('entrar', r.mensaje ?? null);
          })
        }
      >
        {emailField}
        {codeField}
        {newPasswordFields}
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
          Cambiar contraseña
        </Button>
      </form>
    );

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-zinc-950 p-10 text-white lg:flex">
        <div className="pointer-events-none absolute -top-32 -left-32 size-[28rem] rounded-full bg-brand/30 blur-3xl" />
        <div className="pointer-events-none absolute -right-24 bottom-0 size-80 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="relative flex items-center gap-2">
          <img src="./forja.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">Forja</span>
        </div>
        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-balance">Planea con los mejores modelos. Construye en paralelo con muchos agentes.</h1>
            <p className="text-white/70">Tus cuentas de Claude y Codex trabajando a la vez, con revisión, pruebas y trazabilidad de cada tarea.</p>
          </div>
          <ul className="space-y-4">
            <Feature icon={<BotIcon />} title="Seis roles" text="Orquestador, implementador, integrador, revisor, auditor y QA." />
            <Feature icon={<UsersIcon />} title="Varias cuentas" text="Reparte el trabajo entre todas tus cuentas y sigue cuando una se queda sin cuota." />
            <Feature icon={<GitBranchIcon />} title="Tu rama principal intacta" text="Todo se entrega en una rama aparte, verificado." />
            <Feature icon={<ShieldCheckIcon />} title="Privado" text="Sin sesión no se puede ver ni hacer nada." />
          </ul>
        </div>
        <p className="relative text-xs text-white/50">Forja · open source · Apache-2.0</p>
      </aside>
      <main className="flex items-center justify-center p-4 sm:p-8">
        <Card className="w-full max-w-sm border-0 shadow-none sm:border sm:shadow-sm">
          <CardHeader>
            <div className="mb-2 flex items-center gap-2 lg:hidden">
              <img src="./forja.svg" alt="" className="size-7" />
              <span className="font-semibold">Forja</span>
            </div>
            <CardTitle className="text-2xl tracking-tight">{title[step][0]}</CardTitle>
            <CardDescription>{title[step][1]}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {info ? (
              <Alert>
                <AlertDescription>{info}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {form}
          </CardContent>
          <CardFooter className="flex-col gap-2 text-sm text-muted-foreground">
            {step !== 'entrar' ? (
              <button type="button" className="inline-flex items-center gap-1 underline-offset-4 hover:underline" onClick={() => go('entrar')}>
                <ArrowLeftIcon className="size-3.5" /> Volver a entrar
              </button>
            ) : open ? (
              <p>
                ¿Primera vez?{' '}
                <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => go('registro')}>
                  Crea la cuenta del dueño
                </button>
              </p>
            ) : (
              <p>El registro está cerrado.</p>
            )}
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginPage />
  </StrictMode>,
);
