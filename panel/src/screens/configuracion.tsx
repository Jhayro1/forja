import {
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MailIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCogIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '@/app/context';
import { Field, Mono, PageHeader, Section, StatusBadge } from '@/components/common';
import { JobCard } from '@/components/job-card';
import { EffortPicker, ModelPicker } from '@/components/model-picker';
import { RoleBadge } from '@/components/role-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { safeUrl } from '@/lib/format';
import type { Check, Configuracion as Config, Correo, Cuenta, Effort, LoginState, RoleName, Sistema } from '@/lib/types';

const PROVIDER = { claude: 'Claude Code', codex: 'Codex' } as const;
type Provider = keyof typeof PROVIDER;

const ROLE_TITLE: Record<RoleName, string> = {
  planeador: 'Orquestador (planea y conversa)',
  trabajador: 'Implementador: tareas simples',
  complejo: 'Implementador: tareas complejas',
  revisor: 'Revisor',
  integrador: 'Integrador',
  auditor: 'Auditor',
  qa: 'QA',
};

// ─────────────────────────── cuentas ───────────────────────────

function AccountLogin({ c }: { c: Cuenta }) {
  const [code, setCode] = useState('');
  const { run } = useAction();
  const s: LoginState | null = c.inicio_sesion;
  const base = `/v1/cuentas/${c.proveedor}/${c.alias}/sesion`;
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
    <Button variant="ghost" size="sm" onClick={() => void run(`${base}/cancelar`)}>
      Cancelar
    </Button>
  );
  if (c.proveedor === 'claude' && !s.pide_codigo)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Verificando el código… {cancel}
      </div>
    );
  const url = safeUrl(s.url);
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm">
        {s.pide_codigo
          ? '1. Abre la página e inicia sesión con ESTA cuenta. 2. Copia el código. 3. Pégalo aquí.'
          : 'Abre la página e inicia sesión con esta cuenta (si abajo aparece un código, escríbelo en esa página); se completa solo.'}
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
          <Input aria-label={`Código de ${c.alias}`} placeholder="Pega aquí el código" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button onClick={() => (code.trim() ? void run(`${base}/codigo`, { codigo: code.trim() }) : toast('Pega el código', 'error'))}>Enviar</Button>
        </div>
      ) : null}
      {!s.pide_codigo && s.salida?.length ? <pre className="max-h-32 overflow-auto rounded-md bg-background p-2 font-mono text-xs whitespace-pre-wrap">{s.salida.slice(-6).join('\n')}</pre> : null}
      {s.mensaje ? <p className="text-xs text-muted-foreground">{s.mensaje}</p> : null}
      {cancel}
    </div>
  );
}

function AccountRow({ c }: { c: Cuenta }) {
  const { run } = useAction();
  const busy = c.inicio_sesion && (c.inicio_sesion.estado === 'iniciando' || c.inicio_sesion.estado === 'esperando');
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRoundIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">@{c.alias}</span>
        {c.principal ? <span className="text-xs text-muted-foreground">(la del CLI)</span> : null}
        <StatusBadge tone={!c.sesion_iniciada ? 'warn' : c.activa ? 'ok' : 'muted'}>{!c.sesion_iniciada ? 'sin sesión' : c.activa ? 'activa' : 'desactivada'}</StatusBadge>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id={`act-${c.proveedor}-${c.alias}`}
              checked={c.activa}
              onCheckedChange={(v) => void run(`/v1/cuentas/${c.proveedor}/${c.alias}`, { activa: v }, { quiet: true })}
              aria-label={`Usar la cuenta ${c.alias}`}
            />
            <Label htmlFor={`act-${c.proveedor}-${c.alias}`} className="text-xs text-muted-foreground">
              en uso
            </Label>
          </div>
          <Input
            type="number"
            min={1}
            max={16}
            className="h-8 w-24"
            placeholder="sin límite"
            defaultValue={c.max_agentes ?? ''}
            aria-label={`Máximo de agentes a la vez en ${c.alias}`}
            onBlur={(e) => {
              const v = e.target.value.trim();
              const n = v ? Number(v) : null;
              if (n !== c.max_agentes) void run(`/v1/cuentas/${c.proveedor}/${c.alias}`, { max_agentes: n }, { quiet: true });
            }}
          />
          {!busy ? (
            <Button size="sm" variant={c.sesion_iniciada ? 'outline' : 'default'} onClick={() => void run(`/v1/cuentas/${c.proveedor}/${c.alias}/sesion`)}>
              {c.sesion_iniciada ? 'Volver a iniciar sesión' : 'Iniciar sesión'}
            </Button>
          ) : null}
          {!c.principal ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Eliminar la cuenta ${c.alias}`}
              onClick={() =>
                void run(
                  `/v1/cuentas/${c.proveedor}/${c.alias}/eliminar`,
                  {},
                  {
                    confirm: {
                      title: `¿Eliminar la cuenta @${c.alias}?`,
                      description: 'Se borra su sesión guardada en este equipo. Puedes volver a agregarla.',
                      destructive: true,
                      confirm: 'Eliminar',
                    },
                  },
                ).then(() => undefined)
              }
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      </div>
      <p className="font-mono text-[11px] break-all text-muted-foreground">{c.carpeta}</p>
      <AccountLogin c={c} />
    </li>
  );
}

function ProviderAccounts({ p, check, accounts }: { p: Provider; check: Check | undefined; accounts: Cuenta[] }) {
  const { run } = useAction();
  const [alias, setAlias] = useState('');
  const installed = check && !/no instalado/.test(check.detail);
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{PROVIDER[p]}</CardTitle>
        <CardDescription>{check?.detail ?? ''}</CardDescription>
        <CardAction>
          {!installed ? (
            <Button size="sm" onClick={() => void run(`/v1/sistema/proveedores/${p}/instalar`)}>
              Instalar
            </Button>
          ) : (
            <StatusBadge tone={accounts.some((a) => a.sesion_iniciada && a.activa) ? 'ok' : 'warn'}>{accounts.filter((a) => a.sesion_iniciada && a.activa).length} cuenta(s) lista(s)</StatusBadge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {accounts.map((c) => (
            <AccountRow key={c.alias} c={c} />
          ))}
        </ul>
      </CardContent>
      <CardFooter className="gap-2 border-t py-3">
        <Input
          className="h-8 max-w-56"
          placeholder="alias, p. ej. trabajo"
          value={alias}
          onChange={(e) => setAlias(e.target.value.toLowerCase())}
          aria-label={`Alias de la nueva cuenta de ${PROVIDER[p]}`}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            if (!alias.trim()) return toast('Escribe un alias para la cuenta', 'error');
            if (await run('/v1/cuentas', { proveedor: p, alias: alias.trim() })) setAlias('');
          }}
        >
          <PlusIcon /> Agregar cuenta
        </Button>
      </CardFooter>
    </Card>
  );
}

function AccountsTab({ s }: { s: Sistema }) {
  const q = useApiQuery<{ cuentas: Cuenta[] }>('/v1/cuentas', {
    fastPoll: (d) => Boolean(d?.cuentas.some((c) => c.inicio_sesion && (c.inicio_sesion.estado === 'iniciando' || c.inicio_sesion.estado === 'esperando'))),
  });
  const list = q.data?.cuentas ?? [];
  const check = (id: string) => s.checks.find((c) => c.id === id);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Agrega varias cuentas de Claude y de Codex: Forja reparte los agentes entre ellas y, si una se queda sin cuota, sigue con las demás. Cada cuenta guarda su sesión en su propia carpeta; tus
        claves nunca pasan por Forja.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {(['claude', 'codex'] as const).map((p) => (
          <ProviderAccounts key={p} p={p} check={check(p)} accounts={list.filter((c) => c.proveedor === p)} />
        ))}
      </div>
      <JobCard job={s.trabajo} base="/v1/sistema/trabajos" />
    </div>
  );
}

// ─────────────────────────── modelos ───────────────────────────

type Draft = { roles: Record<string, [string, string]>; esfuerzo: Partial<Record<RoleName, Effort | null>>; paralelo: number };

function toDraft(cfg: Config): Draft {
  return {
    roles: Object.fromEntries(cfg.roles.map((r) => [r.rol, [r.modelos[0] ?? '', r.modelos[1] ?? '']])),
    esfuerzo: Object.fromEntries(cfg.roles.map((r) => [r.rol, r.esfuerzo])),
    paralelo: cfg.paralelo,
  };
}

function ModelsForm({ cfg }: { cfg: Config }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(cfg));
  const { run } = useAction();
  const { projectChanged } = useApp();
  const models = cfg.catalogo.modelos;
  const set = (rol: RoleName, i: 0 | 1, ref: string) =>
    setDraft((d) => {
      const cur = d.roles[rol] ?? ['', ''];
      return { ...d, roles: { ...d.roles, [rol]: i === 0 ? [ref, cur[1]] : [cur[0], ref] } };
    });
  const save = async () => {
    const roles = Object.fromEntries(Object.entries(draft.roles).map(([k, v]) => [k, v.filter(Boolean)]));
    const esfuerzo = Object.fromEntries(Object.entries(draft.esfuerzo).filter(([, v]) => v));
    if (await run('/v1/configuracion', { roles, esfuerzo, paralelo: draft.paralelo })) await projectChanged('configuracion');
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {cfg.roles.map((r) => {
          const pair = draft.roles[r.rol] ?? ['', ''];
          const main = models.find((m) => m.ref === pair[0]);
          return (
            <Card key={r.rol} className="gap-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <RoleBadge role={r.rol} /> {ROLE_TITLE[r.rol] ?? r.rol}
                </CardTitle>
                <CardDescription>{r.ayuda}</CardDescription>
              </CardHeader>
              <CardContent className="grid items-start gap-4 sm:grid-cols-2">
                <Field label="Modelo" htmlFor={`${r.rol}-0`} help={main?.descripcion}>
                  <ModelPicker id={`${r.rol}-0`} label={`${r.rol}: modelo`} value={pair[0]} onChange={(v) => set(r.rol, 0, v)} models={models} />
                </Field>
                <Field label="Respaldo" htmlFor={`${r.rol}-1`}>
                  <ModelPicker id={`${r.rol}-1`} label={`${r.rol}: respaldo`} value={pair[1]} onChange={(v) => set(r.rol, 1, v)} models={models} optional />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Esfuerzo de razonamiento" htmlFor={`${r.rol}-esfuerzo`} help={main && !main.esfuerzos.length ? 'Este modelo no tiene esfuerzo configurable.' : undefined}>
                    <EffortPicker
                      id={`${r.rol}-esfuerzo`}
                      value={draft.esfuerzo[r.rol] ?? null}
                      onChange={(e) => setDraft((d) => ({ ...d, esfuerzo: { ...d.esfuerzo, [r.rol]: e } }))}
                      efforts={cfg.catalogo.esfuerzos}
                      model={main}
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card>
        <CardContent className="grid max-w-sm gap-2">
          <Label htmlFor="paralelo">Agentes trabajando a la vez</Label>
          <Input id="paralelo" type="number" min={1} max={16} value={draft.paralelo} onChange={(e) => setDraft((d) => ({ ...d, paralelo: Number(e.target.value) }))} />
          <p className="text-xs text-muted-foreground">Con varias cuentas conviene subirlo: el trabajo se reparte entre ellas.</p>
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

// ─────────────────────────── correo ───────────────────────────

const EMPTY_MAIL = { activo: true, host: '', puerto: 587, seguridad: 'starttls' as const, usuario: '', clave: '', remitente: '', nombre_remitente: 'Forja', destinatario: '', avisos: {} };

function MailTab() {
  const q = useApiQuery<{ correo: Correo | null }>('/v1/correo');
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<typeof EMPTY_MAIL & { avisos: Record<string, boolean> }>({ ...EMPTY_MAIL });
  const current = q.data?.correo ?? null;
  useEffect(() => {
    if (current)
      setDraft({
        activo: current.activo,
        host: current.host,
        puerto: current.puerto,
        seguridad: current.seguridad as 'starttls',
        usuario: current.usuario,
        clave: '',
        remitente: current.remitente,
        nombre_remitente: current.nombre_remitente,
        destinatario: current.destinatario,
        avisos: Object.fromEntries(Object.entries(current.avisos).map(([k, v]) => [k, v !== false])),
      });
  }, [current]);
  const kinds = current?.avisos_disponibles ?? [
    { id: 'chat', texto: 'El planeador respondió' },
    { id: 'trabajos', texto: 'Terminó un trabajo' },
    { id: 'runs', texto: 'Un run terminó o se detuvo' },
    { id: 'pendientes', texto: 'Algo espera tu respuesta' },
    { id: 'observaciones', texto: 'Hay observaciones nuevas' },
  ];
  const env = current?.desde_entorno ?? false;
  const upd = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => void run('/v1/correo', { ...draft, puerto: Number(draft.puerto), ...(draft.clave ? {} : { clave: undefined }) });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailIcon className="size-4" /> Servidor de correo (SMTP)
          </CardTitle>
          <CardDescription>Para avisarte cuando termine un trabajo o algo espere tu respuesta.</CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              <Switch id="correo-activo" checked={draft.activo} disabled={env} onCheckedChange={(v) => upd({ activo: v })} />
              <Label htmlFor="correo-activo">Activo</Label>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {env ? (
            <Alert className="sm:col-span-2">
              <AlertTitle>Configurado por el servidor</AlertTitle>
              <AlertDescription>Las variables FORJA_SMTP_* mandan sobre lo que guardes aquí.</AlertDescription>
            </Alert>
          ) : null}
          <Field label="Servidor" htmlFor="smtp-host">
            <Input id="smtp-host" disabled={env} placeholder="mail.tudominio.com" value={draft.host} onChange={(e) => upd({ host: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Puerto" htmlFor="smtp-puerto">
              <Input id="smtp-puerto" disabled={env} type="number" value={draft.puerto} onChange={(e) => upd({ puerto: Number(e.target.value) })} />
            </Field>
            <Field label="Seguridad" htmlFor="smtp-seg">
              <Select
                disabled={env}
                value={draft.seguridad}
                onValueChange={(v) => upd({ seguridad: v as 'starttls', puerto: v === 'tls' && draft.puerto === 587 ? 465 : v === 'starttls' && draft.puerto === 465 ? 587 : draft.puerto })}
              >
                <SelectTrigger id="smtp-seg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starttls">STARTTLS</SelectItem>
                  <SelectItem value="tls">TLS</SelectItem>
                  <SelectItem value="ninguna">Ninguna</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Usuario" htmlFor="smtp-usuario">
            <Input id="smtp-usuario" disabled={env} autoComplete="off" placeholder="noreply@tudominio.com" value={draft.usuario} onChange={(e) => upd({ usuario: e.target.value })} />
          </Field>
          <Field
            label="Clave de aplicación"
            htmlFor="smtp-clave"
            help={current?.clave_guardada ? 'Hay una clave guardada (cifrada). Déjalo vacío para conservarla.' : 'En Auralis Mail, créala en tu cuenta → Claves de aplicación.'}
          >
            <Input id="smtp-clave" disabled={env} type="password" autoComplete="new-password" value={draft.clave} onChange={(e) => upd({ clave: e.target.value })} />
          </Field>
          <Field label="Remitente" htmlFor="smtp-remitente">
            <Input id="smtp-remitente" disabled={env} type="email" placeholder="noreply@tudominio.com" value={draft.remitente} onChange={(e) => upd({ remitente: e.target.value })} />
          </Field>
          <Field label="Nombre del remitente" htmlFor="smtp-nombre">
            <Input id="smtp-nombre" disabled={env} value={draft.nombre_remitente} onChange={(e) => upd({ nombre_remitente: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Enviar los avisos a" htmlFor="smtp-dest">
              <Input id="smtp-dest" disabled={env} type="email" placeholder="tu@correo.com" value={draft.destinatario} onChange={(e) => upd({ destinatario: e.target.value })} />
            </Field>
          </div>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button disabled={env || busy !== null} onClick={save}>
            Guardar
          </Button>
          <Button variant="outline" disabled={!current || busy !== null} onClick={() => void run('/v1/correo/prueba')}>
            <SendIcon /> Enviar correo de prueba
          </Button>
        </CardFooter>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Qué avisos quieres</CardTitle>
          <CardDescription>El correo lleva el proyecto y qué pasó. Nunca código ni secretos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {kinds.map((k) => (
            <div key={k.id} className="flex items-start gap-3">
              <Switch id={`aviso-${k.id}`} disabled={env} checked={draft.avisos[k.id] !== false} onCheckedChange={(v) => upd({ avisos: { ...draft.avisos, [k.id]: v } })} className="mt-0.5" />
              <Label htmlFor={`aviso-${k.id}`} className="leading-snug font-normal">
                {k.texto}
              </Label>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────── máquina y cuenta ───────────────────────────

const LEVEL_ICON = { ok: CircleCheckIcon, aviso: TriangleAlertIcon, error: CircleAlertIcon };
const LEVEL_COLOR = { ok: 'text-success', aviso: 'text-warning', error: 'text-destructive' };

function MachineTab({ s, onRefresh }: { s: Sistema; onRefresh: () => void }) {
  const others = s.checks.filter((c) => c.id !== 'claude' && c.id !== 'codex');
  return (
    <Section
      title="Tu máquina"
      actions={
        <Button variant="outline" size="sm" onClick={onRefresh}>
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
  );
}

function OwnerTab() {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [otra, setOtra] = useState('');
  const change = async () => {
    if (nueva !== otra) return toast('Las contraseñas nuevas no coinciden', 'error');
    try {
      const res = await fetch('/v1/auth/clave', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Forja-CSRF': (await api.get<{ csrf: string }>('/v1/sesion')).csrf },
        body: JSON.stringify({ actual, nueva }),
      });
      const data = (await res.json()) as { mensaje?: string; error?: { mensaje?: string } };
      if (!res.ok) throw new Error(data.error?.mensaje ?? `error ${res.status}`);
      toast(data.mensaje ?? 'Contraseña cambiada');
      setActual('');
      setNueva('');
      setOtra('');
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    }
  };
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCogIcon className="size-4" /> Tu acceso
        </CardTitle>
        <CardDescription>Sólo el dueño entra a esta instalación. Cambiar la contraseña cierra las demás sesiones.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field label="Contraseña actual" htmlFor="clave-actual">
          <Input id="clave-actual" type="password" autoComplete="current-password" value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña" htmlFor="clave-nueva" help="Al menos 10 caracteres.">
          <Input id="clave-nueva" type="password" autoComplete="new-password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
        </Field>
        <Field label="Repite la nueva" htmlFor="clave-otra">
          <Input id="clave-otra" type="password" autoComplete="new-password" value={otra} onChange={(e) => setOtra(e.target.value)} />
        </Field>
      </CardContent>
      <CardFooter className="gap-2">
        <Button onClick={() => void change()} disabled={!actual || nueva.length < 10}>
          Cambiar contraseña
        </Button>
        <Button variant="outline" onClick={() => void api.logout()}>
          Cerrar sesión
        </Button>
      </CardFooter>
    </Card>
  );
}

export default function Configuracion() {
  const { has, server } = useApp();
  const [refresh, setRefresh] = useState(false);
  const sys = useApiQuery<{ sistema: Sistema }>(refresh ? '/v1/sistema?refrescar=1' : '/v1/sistema', { fastPoll: (d) => d?.sistema.trabajo?.estado === 'corriendo' });
  const cfg = useApiQuery<{ configuracion: Config }>(has('configuracion') ? '/v1/configuracion' : null);
  useEffect(() => {
    if (refresh && sys.isFetched) setRefresh(false);
  }, [refresh, sys.isFetched]);
  const s = sys.data?.sistema;
  if (!s) return <PageHeader title="Ajustes" description="Revisando tu máquina…" />;
  const summary = { ok: 'Todo listo para trabajar.', aviso: 'Se puede trabajar, con avisos.', error: 'Falta algo para poder trabajar.' }[s.estado];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Ajustes"
        description={summary}
        actions={<StatusBadge tone={s.estado === 'ok' ? 'ok' : s.estado === 'error' ? 'error' : 'warn'}>{s.estado === 'ok' ? 'listo' : s.estado}</StatusBadge>}
      />
      <Tabs defaultValue="cuentas">
        <TabsList className="flex-wrap">
          <TabsTrigger value="cuentas">Cuentas de IA</TabsTrigger>
          <TabsTrigger value="modelos">Modelos por rol</TabsTrigger>
          {has('correo') ? <TabsTrigger value="correo">Correo</TabsTrigger> : null}
          <TabsTrigger value="maquina">Tu máquina</TabsTrigger>
          {server ? <TabsTrigger value="acceso">Tu acceso</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="cuentas" className="mt-4">
          {has('cuentas') ? <AccountsTab s={s} /> : null}
        </TabsContent>
        <TabsContent value="modelos" className="mt-4">
          {cfg.data ? (
            <ModelsForm key={JSON.stringify(cfg.data.configuracion.roles)} cfg={cfg.data.configuracion} />
          ) : (
            <Alert>
              <AlertTitle>Sin proyecto</AlertTitle>
              <AlertDescription>Elige un proyecto para configurar qué modelo usa cada rol.</AlertDescription>
            </Alert>
          )}
        </TabsContent>
        <TabsContent value="correo" className="mt-4">
          <MailTab />
        </TabsContent>
        <TabsContent value="maquina" className="mt-4">
          <MachineTab
            s={s}
            onRefresh={() => {
              api.clear();
              setRefresh(true);
            }}
          />
        </TabsContent>
        {server ? (
          <TabsContent value="acceso" className="mt-4">
            <OwnerTab />
          </TabsContent>
        ) : null}
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Las cuentas se guardan en <Mono>~/.forja/cuentas</Mono>; el correo, cifrado, en <Mono>~/.forja/correo.json</Mono>.
      </p>
    </div>
  );
}
