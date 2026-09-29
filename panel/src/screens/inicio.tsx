import { ArrowRightIcon, BotIcon, CheckCircle2Icon, CheckIcon, CircleDotIcon, ClockIcon, FlagIcon, ShieldAlertIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '@/app/context';
import { Mono, PageHeader } from '@/components/common';
import { RoleBadge } from '@/components/role-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api';
import { elapsed, fecha } from '@/lib/format';
import type { Agentes, EstadoV3, Observaciones, Planeacion } from '@/lib/types';
import { cn } from '@/lib/utils';

function Stat({ icon, label, value, hint, tone, onClick }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'ok' | 'bad'; onClick?: () => void }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className={cn(
            'flex size-8 items-center justify-center rounded-lg bg-muted [&_svg]:size-4',
            tone === 'warn' && 'bg-warning/15 text-foreground',
            tone === 'ok' && 'bg-success/15 text-success',
            tone === 'bad' && 'bg-destructive/10 text-destructive',
          )}
        >
          {icon}
        </span>
        {label}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border bg-card p-5 text-left shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {body}
    </button>
  ) : (
    <div className="rounded-xl border bg-card p-5 shadow-xs">{body}</div>
  );
}

/** The sprint's phases, named by the server's text catalogue (the panel keeps no vocabulary of its own). */
function PhaseTrack({ phase }: { phase: string | null }) {
  const { textos } = useApp();
  const phases = textos.fases;
  const now = phase ? phases.findIndex(([id]) => id === phase) : -1;
  return (
    <ol aria-label="Fases del sprint" className="grid grid-cols-6 gap-1">
      {phases.map(([id, label], i) => {
        const done = phase === 'entregado' || (now >= 0 && i < now);
        const current = i === now && phase !== 'entregado';
        return (
          <li key={id} aria-current={current ? 'step' : undefined} className="space-y-1.5">
            <div className={cn('h-1.5 rounded-full bg-muted', done && 'bg-success', current && 'bg-brand')} />
            <p className={cn('flex items-center gap-1 truncate text-[11px] text-muted-foreground', current && 'font-medium text-foreground')}>
              {done ? <CheckIcon className="size-3 text-success" /> : null}
              {label}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export default function Resumen() {
  const { go, openTask, has, project } = useApp();
  const est = useApiQuery<{ estado: EstadoV3 }>('/v1/estado', { fastPoll: (d) => Boolean(d?.estado.run?.activo) });
  const pl = useApiQuery<{ planeacion: Planeacion }>(has('planeacion') ? '/v1/planeacion' : null);
  const obs = useApiQuery<{ observaciones: Observaciones }>(has('trabajo') ? '/v1/observaciones' : null);
  const ag = useApiQuery<{ agentes: Agentes }>(has('trabajo') ? '/v1/agentes' : null, { fastPoll: (d) => Boolean(d?.agentes.roles.some((r) => r.estado === 'activo')) });
  const e = est.data?.estado;
  if (!e)
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );

  if (!e.cambio)
    return (
      <div className="space-y-6">
        <PageHeader title={project?.nombre ?? 'Proyecto'} description="Todavía no hay sprints en este proyecto." />
        <Card className="overflow-hidden border-brand/30 bg-gradient-to-br from-brand/10 via-card to-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <SparklesIcon className="size-5 text-brand" /> Cuéntale a Forja qué quieres construir
            </CardTitle>
            <CardDescription>El orquestador te hace preguntas hasta dejarlo claro, lo especifica, lo divide en tareas y los agentes lo programan en paralelo.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="lg" onClick={() => go('sprint')}>
              Empezar un sprint <ArrowRightIcon />
            </Button>
          </CardContent>
        </Card>
      </div>
    );

  const next = e.siguiente_accion;
  const pct = e.progreso.total ? Math.round((100 * e.progreso.integradas) / e.progreso.total) : 0;
  const working = e.tareas.filter((t) => t.estado === 'ejecutando' || t.estado === 'reservada');
  const recent = e.tareas
    .filter((t) => t.estado === 'integrada' && t.resumen)
    .slice(-5)
    .reverse();
  const openObs = obs.data?.observaciones.conteo.abierta ?? 0;
  const activeRoles = ag.data?.agentes.roles.filter((r) => r.estado === 'activo') ?? [];
  const change = pl.data?.planeacion.cambio;

  return (
    <div className="space-y-6">
      <PageHeader
        title={e.cambio.titulo}
        description={
          <span className="flex flex-wrap items-center gap-2">
            Sprint actual
            {e.run?.activo ? (
              <Badge variant="outline" className="border-brand/40 bg-brand/10">
                <CircleDotIcon className="animate-pulse text-brand" /> ejecutando
              </Badge>
            ) : null}
            {e.entrega ? (
              <span>
                · entregado en <Mono>{e.entrega}</Mono>
              </span>
            ) : null}
          </span>
        }
      />

      {next ? (
        <Card
          className={cn('overflow-hidden', next.urgente ? 'border-warning/50 bg-gradient-to-br from-warning/15 via-card to-card' : 'border-brand/30 bg-gradient-to-br from-brand/10 via-card to-card')}
        >
          <CardHeader>
            <CardDescription className="flex items-center gap-2 font-medium tracking-wide uppercase">
              {next.urgente ? <TriangleAlertIcon className="size-4" /> : <FlagIcon className="size-4" />} Siguiente paso
            </CardDescription>
            <CardTitle className="text-xl leading-snug">{next.titulo}</CardTitle>
            <CardAction>
              <Button onClick={() => go(next.vista)}>
                Ir <ArrowRightIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="line-clamp-3 text-sm text-muted-foreground">{next.motivo}</p>
            <PhaseTrack phase={change?.fase ?? e.cambio.fase} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<CheckCircle2Icon />}
          tone="ok"
          label="Tareas unidas"
          value={
            <>
              {e.progreso.integradas}
              <span className="text-lg text-muted-foreground">/{e.progreso.total}</span>
            </>
          }
          hint={<Progress value={pct} className="mt-1 h-1.5" aria-label="Avance" />}
          onClick={() => go('tablero')}
        />
        <Stat
          icon={<BotIcon />}
          label="Agentes trabajando"
          value={working.length}
          hint={e.progreso.minutos_restantes ? `≈${Math.max(1, Math.round(e.progreso.minutos_restantes))} min restantes (estimado)` : 'nadie ejecutando ahora'}
          onClick={() => go('agentes')}
        />
        <Stat
          icon={<TriangleAlertIcon />}
          tone={e.pendientes.length ? 'warn' : undefined}
          label="Esperan tu decisión"
          value={e.pendientes.length}
          hint={e.pendientes[0] ? `${e.pendientes[0].id}: ${e.pendientes[0].text.slice(0, 60)}` : 'nada pendiente'}
          onClick={() => go('tablero')}
        />
        <Stat
          icon={<ShieldAlertIcon />}
          tone={openObs ? 'bad' : undefined}
          label="Observaciones abiertas"
          value={openObs}
          hint={obs.data?.observaciones.validacion ? `última validación ${fecha(obs.data.observaciones.validacion.fecha)}` : 'sin validar todavía'}
          onClick={() => go('calidad')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Agentes ahora</CardTitle>
            <CardDescription>Quién trabaja, en qué y con qué cuenta.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => go('agentes')}>
                Ver todos <ArrowRightIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {working.length || activeRoles.some((r) => r.otra_actividad) ? (
              <ul className="divide-y">
                {activeRoles
                  .filter((r) => r.otra_actividad)
                  .map((r) => (
                    <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <RoleBadge role={r.roles_forja[0]!} />
                      <span className="truncate">{r.otra_actividad}</span>
                    </li>
                  ))}
                {working.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="flex w-full items-center gap-3 py-2.5 text-left text-sm hover:bg-accent/40" onClick={() => openTask(t.id)}>
                      {t.rol ? <RoleBadge role={t.rol} /> : null}
                      <Mono className="text-muted-foreground">{t.id}</Mono>
                      <span className="min-w-0 flex-1 truncate">{t.titulo}</span>
                      <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                        {t.modelo?.replace(/^(claude|codex):/, '')}
                        {t.cuenta && t.cuenta !== 'principal' ? ` @${t.cuenta}` : ''}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <ClockIcon className="size-3" />
                        {elapsed(t.actividad?.startedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Ningún agente trabajando ahora.</p>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Lo último que se unió</CardTitle>
            <CardDescription>Lo que ahora hace el sistema, contado por cada agente.</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length ? (
              <ul className="space-y-3">
                {recent.map((t) => (
                  <li key={t.id} className="text-sm">
                    <button type="button" className="text-left" onClick={() => openTask(t.id)}>
                      <span className="flex items-center gap-2 font-medium">
                        <CheckIcon className="size-3.5 text-success" /> <Mono className="text-muted-foreground">{t.id}</Mono> <span className="truncate">{t.titulo}</span>
                      </span>
                      <span className="line-clamp-2 pl-5 text-xs text-muted-foreground">{t.resumen}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Todavía no se unió ninguna tarea.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
