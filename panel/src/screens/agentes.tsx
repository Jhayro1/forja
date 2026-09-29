import { BotIcon, CircleDotIcon, ClockIcon, KeyRoundIcon, PauseCircleIcon, SettingsIcon } from 'lucide-react';
import { useApp } from '@/app/context';
import { Mono, PageHeader, Section, StatusBadge } from '@/components/common';
import { ROLE_OF } from '@/components/role-badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApiQuery } from '@/hooks/use-api';
import { elapsed, tokens } from '@/lib/format';
import type { Agentes as AgentesT, RolAgente } from '@/lib/types';
import { cn } from '@/lib/utils';

function RoleCard({ r }: { r: RolAgente }) {
  const { openTask } = useApp();
  const style = ROLE_OF[r.roles_forja[0] ?? ''];
  const active = r.estado === 'activo';
  return (
    <Card className={cn('gap-4 transition-shadow', active && 'shadow-md ring-1 ring-brand/30')}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className={cn('flex size-10 items-center justify-center rounded-xl border', style?.className)}>
            <BotIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">{r.titulo}</CardTitle>
            <CardDescription className="flex items-center gap-1.5 text-xs">
              {active ? (
                <>
                  <CircleDotIcon className="size-3 animate-pulse text-brand" /> trabajando
                </>
              ) : (
                'inactivo · espera trabajo'
              )}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <StatusBadge tone={active ? 'info' : 'muted'}>{active ? `${r.trabajando.length || 1} en curso` : 'libre'}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{r.descripcion}</p>
        {r.otra_actividad ? <p className="rounded-md bg-muted px-3 py-2 text-xs">{r.otra_actividad}</p> : null}
        {r.trabajando.length ? (
          <ul className="space-y-1.5">
            {r.trabajando.map((t) => (
              <li key={t.tarea}>
                <button type="button" onClick={() => openTask(t.tarea)} className="flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-accent/50">
                  <Mono className="text-muted-foreground">{t.tarea}</Mono>
                  <span className="min-w-0 flex-1 truncate">{t.titulo}</span>
                  {t.cuenta && t.cuenta !== 'principal' ? <span className="text-muted-foreground">@{t.cuenta}</span> : null}
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <ClockIcon className="size-3" /> {elapsed(t.desde)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
      <CardFooter className="mt-auto flex-col items-start gap-1 border-t pt-4 text-xs text-muted-foreground">
        <span className="flex flex-wrap gap-1">
          {r.modelos.map((m) => (
            <Mono key={m} className="rounded bg-muted px-1.5 py-0.5">
              {m}
            </Mono>
          ))}
        </span>
        <span>
          esfuerzo {r.esfuerzo ?? 'por defecto'} · {r.llamadas} llamada{r.llamadas === 1 ? '' : 's'} en este run
          {r.tokens !== null ? ` · ${tokens(r.tokens)} tokens` : ''}
        </span>
      </CardFooter>
    </Card>
  );
}

export default function Agentes() {
  const { go } = useApp();
  const q = useApiQuery<{ agentes: AgentesT }>('/v1/agentes', { fastPoll: (d) => Boolean(d?.agentes.roles.some((r) => r.estado === 'activo')) });
  const a = q.data?.agentes;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Agentes"
        description="Seis roles con responsabilidades distintas. Un rol sin trabajo está inactivo, no fallando."
        actions={
          <Button variant="outline" onClick={() => go('configuracion')}>
            <SettingsIcon /> Modelos y cuentas
          </Button>
        }
      />
      {a ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {a.roles.map((r) => (
            <RoleCard key={r.id} r={r} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      )}
      {a ? (
        <Section title="Cuentas" description="El trabajo se reparte entre tus cuentas: si una se queda sin cuota, las demás siguen.">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cuenta</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Agentes ahora</TableHead>
                  <TableHead className="hidden sm:table-cell">Límite</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.cuentas.map((c) => (
                  <TableRow key={`${c.proveedor}@${c.alias}`}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <KeyRoundIcon className="size-4 text-muted-foreground" />
                        <span className="font-medium">{c.proveedor === 'claude' ? 'Claude' : 'Codex'}</span>
                        <Mono className="text-muted-foreground">@{c.alias}</Mono>
                      </span>
                    </TableCell>
                    <TableCell>
                      {!c.activa ? (
                        <StatusBadge tone="muted">desactivada</StatusBadge>
                      ) : !c.sesion ? (
                        <StatusBadge tone="warn">sin sesión</StatusBadge>
                      ) : c.en_pausa ? (
                        <StatusBadge tone="warn">
                          <PauseCircleIcon /> sin cuota
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="ok">lista</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{c.en_curso}</TableCell>
                    <TableCell className="hidden sm:table-cell">{c.max_agentes ?? 'sin límite'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
