import { CircleAlertIcon, CircleCheckIcon, ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '@/app/context';
import { Field, PageHeader, Section, StatusBadge } from '@/components/common';
import { JobCard } from '@/components/job-card';
import { EffortPicker, ModelPicker } from '@/components/model-picker';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { safeUrl } from '@/lib/format';
import type { Check, Configuracion as Config, Effort, LoginState, RoleName, Sistema } from '@/lib/types';

const PROVIDER = { claude: 'Claude Code', codex: 'Codex' } as const;
type Provider = keyof typeof PROVIDER;

const ROLE_TITLE: Record<RoleName, string> = { planeador: 'Planeador (el que piensa)', trabajador: 'Trabajador', complejo: 'Tareas complejas', revisor: 'Revisor' };

function LoginBox({ p, s }: { p: Provider; s: LoginState | null | undefined }) {
  const [code, setCode] = useState('');
  const { run } = useAction();
  if (!s || s.estado === 'cancelado') return null;
  if (s.estado === 'iniciando') return <p className="text-sm text-muted-foreground">Abriendo el inicio de sesión…</p>;
  if (s.estado === 'listo') return <p className="text-sm text-success">✔ Sesión iniciada</p>;
  if (s.estado === 'error')
    return (
      <Alert variant="destructive">
        <AlertDescription>✘ {s.mensaje || 'no se pudo iniciar sesión'}</AlertDescription>
      </Alert>
    );
  const cancel = (
    <Button variant="ghost" size="sm" onClick={() => void run(`/v1/sistema/proveedores/${p}/sesion/cancelar`)}>
      Cancelar
    </Button>
  );
  if (p === 'claude' && !s.pide_codigo)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Verificando el código… {cancel}
      </div>
    );
  const url = safeUrl(s.url);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm">
        {s.pide_codigo ? '1. Abre la página e inicia sesión con tu cuenta. 2. Copia el código que te muestra. 3. Pégalo aquí.' : 'Abre la página e inicia sesión con tu cuenta; esto se completa solo.'}
      </p>
      {url ? (
        <Button asChild size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            Abrir la página para iniciar sesión <ExternalLinkIcon />
          </a>
        </Button>
      ) : null}
      {s.pide_codigo ? (
        <div className="flex gap-2">
          <Input aria-label={`Código de ${PROVIDER[p]}`} placeholder="Pega aquí el código" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button
            onClick={() => {
              if (!code.trim()) return toast('Pega el código', 'error');
              void run(`/v1/sistema/proveedores/${p}/sesion/codigo`, { codigo: code.trim() });
            }}
          >
            Enviar código
          </Button>
        </div>
      ) : null}
      {s.mensaje ? <p className={s.pide_codigo ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{s.mensaje}</p> : null}
      {cancel}
    </div>
  );
}

function ProviderCard({ p, check, session }: { p: Provider; check: Check | undefined; session: LoginState | null | undefined }) {
  const { run } = useAction();
  const installed = check && !/no instalado/.test(check.detail);
  const ready = check?.level === 'ok';
  const busy = session && (session.estado === 'iniciando' || session.estado === 'esperando');
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{PROVIDER[p]}</CardTitle>
        {check ? <CardDescription>{check.detail}</CardDescription> : null}
        <CardAction>
          <StatusBadge tone={ready ? 'ok' : installed ? 'warn' : 'error'}>{ready ? 'listo' : installed ? 'falta iniciar sesión' : 'no instalado'}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {p === 'codex' && !ready ? <p className="text-xs text-muted-foreground">Opcional: con Claude ya puedes trabajar. Con los dos, Forja reparte el trabajo y uno revisa al otro.</p> : null}
        {busy ? null : !installed ? (
          <Button onClick={() => void run(`/v1/sistema/proveedores/${p}/instalar`)}>Instalar {PROVIDER[p]}</Button>
        ) : (
          <Button variant={ready ? 'outline' : 'default'} onClick={() => void run(`/v1/sistema/proveedores/${p}/sesion`)}>
            {ready ? 'Volver a iniciar sesión' : 'Iniciar sesión'}
          </Button>
        )}
        <LoginBox p={p} s={session} />
      </CardContent>
    </Card>
  );
}

type Draft = { roles: Record<RoleName, [string, string]>; esfuerzo: Partial<Record<RoleName, Effort | null>>; paralelo: number };

function toDraft(cfg: Config): Draft {
  return {
    roles: Object.fromEntries(cfg.roles.map((r) => [r.rol, [r.modelos[0] ?? '', r.modelos[1] ?? '']])) as Draft['roles'],
    esfuerzo: Object.fromEntries(cfg.roles.map((r) => [r.rol, r.esfuerzo])),
    paralelo: cfg.paralelo,
  };
}

function ModelsForm({ cfg }: { cfg: Config }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(cfg));
  const { run } = useAction();
  const { projectChanged } = useApp();
  const models = cfg.catalogo.modelos;
  const set = (rol: RoleName, i: 0 | 1, ref: string) => setDraft((d) => ({ ...d, roles: { ...d.roles, [rol]: i === 0 ? [ref, d.roles[rol][1]] : [d.roles[rol][0], ref] } }));
  const save = async () => {
    const roles = Object.fromEntries(Object.entries(draft.roles).map(([k, v]) => [k, v.filter(Boolean)]));
    const esfuerzo = Object.fromEntries(Object.entries(draft.esfuerzo).filter(([, v]) => v));
    if (await run('/v1/configuracion', { roles, esfuerzo, paralelo: draft.paralelo })) await projectChanged('configuracion');
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {cfg.roles.map((r) => {
          const main = models.find((m) => m.ref === draft.roles[r.rol][0]);
          return (
            <Card key={r.rol} className="gap-4">
              <CardHeader>
                <CardTitle className="text-base">{ROLE_TITLE[r.rol]}</CardTitle>
                <CardDescription>{r.ayuda}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <Field label="Modelo" htmlFor={`${r.rol}-0`} help={main?.descripcion}>
                  <ModelPicker id={`${r.rol}-0`} label={`${r.rol}: modelo`} value={draft.roles[r.rol][0]} onChange={(v) => set(r.rol, 0, v)} models={models} />
                </Field>
                <Field label="Respaldo (si el primero no tiene cuota)" htmlFor={`${r.rol}-1`}>
                  <ModelPicker id={`${r.rol}-1`} label={`${r.rol}: respaldo`} value={draft.roles[r.rol][1]} onChange={(v) => set(r.rol, 1, v)} models={models} optional />
                </Field>
                <Field
                  label="Esfuerzo de razonamiento"
                  htmlFor={`${r.rol}-esfuerzo`}
                  help={main && !main.esfuerzos.length ? 'Este modelo no tiene esfuerzo configurable: se ignora.' : 'Más esfuerzo piensa mejor pero tarda y consume más.'}
                >
                  <EffortPicker
                    id={`${r.rol}-esfuerzo`}
                    value={draft.esfuerzo[r.rol] ?? null}
                    onChange={(e) => setDraft((d) => ({ ...d, esfuerzo: { ...d.esfuerzo, [r.rol]: e } }))}
                    efforts={cfg.catalogo.esfuerzos}
                    model={main}
                  />
                </Field>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card>
        <CardContent className="grid max-w-sm gap-2">
          <Label htmlFor="paralelo">Agentes trabajando a la vez</Label>
          <Input id="paralelo" type="number" min={1} max={16} value={draft.paralelo} onChange={(e) => setDraft((d) => ({ ...d, paralelo: Number(e.target.value) }))} />
          <p className="text-xs text-muted-foreground">Más agentes terminan antes pero consumen tu cuota más rápido.</p>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button onClick={() => void save()}>Guardar</Button>
          <Button
            variant="outline"
            onClick={() =>
              void run(
                '/v1/trabajos',
                { tipo: 'conformidad' },
                { confirm: { title: '¿Probar estos modelos?', description: 'Hace una llamada corta a cada modelo configurado para comprobar que funciona (consume poca cuota).' } },
              )
            }
          >
            Probar estos modelos
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

const LEVEL_ICON = { ok: CircleCheckIcon, aviso: TriangleAlertIcon, error: CircleAlertIcon };
const LEVEL_COLOR = { ok: 'text-success', aviso: 'text-warning', error: 'text-destructive' };

export default function Configuracion() {
  const { has } = useApp();
  const [refresh, setRefresh] = useState(false);
  const sys = useApiQuery<{ sistema: Sistema }>(refresh ? '/v1/sistema?refrescar=1' : '/v1/sistema', {
    fastPoll: (d) => d?.sistema.trabajo?.estado === 'corriendo' || Object.values(d?.sistema.sesiones ?? {}).some((s) => s && (s.estado === 'iniciando' || s.estado === 'esperando')),
  });
  const cfg = useApiQuery<{ configuracion: Config }>(has('configuracion') ? '/v1/configuracion' : null);
  useEffect(() => {
    if (refresh && sys.isFetched) setRefresh(false);
  }, [refresh, sys.isFetched]);

  const s = sys.data?.sistema;
  if (!s) return <PageHeader title="Configuración" description="Revisando tu máquina…" />;
  const byId = (id: string) => s.checks.find((c) => c.id === id);
  const others = s.checks.filter((c) => c.id !== 'claude' && c.id !== 'codex');
  const summary = { ok: 'Todo listo para trabajar.', aviso: 'Se puede trabajar, con avisos.', error: 'Falta algo para poder trabajar.' }[s.estado];

  return (
    <div className="space-y-10">
      <PageHeader
        title="Configuración"
        description={summary}
        actions={<StatusBadge tone={s.estado === 'ok' ? 'ok' : s.estado === 'error' ? 'error' : 'warn'}>{s.estado === 'ok' ? 'listo' : s.estado}</StatusBadge>}
      />

      <Section title="Proveedores de IA" description="Forja usa los CLI oficiales con tu propia cuenta: no guarda tus claves.">
        <div className="grid gap-4 md:grid-cols-2">
          <ProviderCard p="claude" check={byId('claude')} session={s.sesiones.claude} />
          <ProviderCard p="codex" check={byId('codex')} session={s.sesiones.codex} />
        </div>
        <JobCard job={s.trabajo} base="/v1/sistema/trabajos" />
      </Section>

      <Section title="Modelos de este proyecto" description="Elige qué modelo usa cada parte del trabajo y cuánto piensa. Se guarda en forja.yaml.">
        {cfg.data ? (
          <ModelsForm key={JSON.stringify(cfg.data.configuracion.roles)} cfg={cfg.data.configuracion} />
        ) : (
          <Alert>
            <AlertTitle>Sin proyecto</AlertTitle>
            <AlertDescription>Elige un proyecto para configurar qué modelos usa cada rol.</AlertDescription>
          </Alert>
        )}
      </Section>

      <Section
        title="Tu máquina"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              api.clear();
              setRefresh(true);
            }}
          >
            <RefreshCwIcon /> Volver a revisar
          </Button>
        }
      >
        <Card className="py-2">
          <ul className="divide-y">
            {others.map((c) => {
              const Icon = LEVEL_ICON[c.level];
              return (
                <li key={c.id} className="flex gap-3 px-6 py-3">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${LEVEL_COLOR[c.level]}`} />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{c.title}</p>
                    <p className="text-muted-foreground">{c.detail}</p>
                    {c.fix && c.level !== 'ok' ? <p className="text-xs text-muted-foreground">→ {c.fix}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </Section>
    </div>
  );
}
