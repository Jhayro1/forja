import { useState } from 'react';
import { EmptyState, Mono, PageHeader, Section, StatusBadge } from '@/components/common';
import { ExcelExportButton } from '@/components/excel-export';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { Planeacion as Data, Pregunta } from '@/lib/types';

function List({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function SpecQuestion({ q }: { q: Pregunta }) {
  const [text, setText] = useState('');
  const { run } = useAction();
  return (
    <Card className={q.respuesta ? 'gap-3' : 'gap-3 border-warning/40'}>
      <CardHeader>
        <CardTitle className="text-sm">{q.id}</CardTitle>
        <CardDescription>{q.texto}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.respuesta ? (
          <p className="text-sm text-muted-foreground">Respuesta: {q.respuesta}</p>
        ) : (
          <>
            <Textarea rows={2} aria-label={`Respuesta para ${q.id}`} value={text} onChange={(e) => setText(e.target.value)} />
            <Button size="sm" onClick={() => (text.trim() ? void run(`/v1/planeacion/preguntas/${q.id}/respuesta`, { respuesta: text.trim() }) : toast('Escribe una respuesta', 'error'))}>
              Responder
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function Planeacion() {
  const { run } = useAction();
  const q = useApiQuery<{ planeacion: Data }>('/v1/planeacion');
  const d = q.data?.planeacion;
  if (!d) return <PageHeader title="Planeación" description="Cargando…" />;
  if (!d.cambio)
    return (
      <>
        <PageHeader title="Planeación" />
        <EmptyState title="Sin cambios todavía">Empieza desde Inicio contándole a Forja qué quieres construir.</EmptyState>
      </>
    );
  const disc = d.descubrimiento;
  const spec = d.especificacion;
  const plan = d.plan;
  return (
    <div className="space-y-10">
      <PageHeader title={`Planeación · ${d.cambio.titulo}`} description={`Fase: ${d.cambio.fase}`} actions={<ExcelExportButton />} />

      <Section title={`Descubrimiento (revisión ${disc.revision})`} actions={disc.aprobado ? <StatusBadge tone="ok">aprobado</StatusBadge> : null}>
        <Card>
          <CardContent className="grid gap-6 md:grid-cols-2">
            {disc.resumen ? <p className="text-sm md:col-span-2">{disc.resumen}</p> : null}
            <div>
              <p className="mb-2 text-sm font-medium">Incluye</p>
              <List items={disc.alcance.incluye} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Excluye</p>
              <List items={disc.alcance.excluye} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Decisiones</p>
              <List items={disc.decisiones.map((x) => `${x.id} · ${x.contenido} (${x.estado})`)} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Preguntas abiertas</p>
              <List items={disc.preguntas_abiertas.map((x) => `${x.id} · ${x.texto}`)} />
            </div>
          </CardContent>
          {d.cambio.fase === 'descubrir' ? (
            <CardFooter className="flex-col items-start gap-2">
              {disc.bloqueos.length ? <p className="text-sm text-destructive">Para aprobar falta: {disc.bloqueos.join('; ')}</p> : null}
              {!disc.aprobado && !disc.bloqueos.length ? (
                <Button onClick={() => void run('/v1/planeacion/descubrimiento/aprobar', {}, { confirm: '¿Aprobar el descubrimiento tal como está?' })}>Aprobar descubrimiento</Button>
              ) : null}
            </CardFooter>
          ) : null}
        </Card>
      </Section>

      {d.conversacion.length ? (
        <Section title={`Conversación (${d.conversacion.length} turnos recientes)`}>
          <Card>
            <CardContent className="space-y-3 text-sm">
              {d.conversacion.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: turns only grow at the end.
                <div key={i} className="space-y-1">
                  {t.usuario ? (
                    <p>
                      <span className="font-medium">Tú:</span> {t.usuario}
                    </p>
                  ) : null}
                  <p className="whitespace-pre-wrap">
                    <span className="font-medium">Planeador ({t.modelo}):</span> {t.planeador}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </Section>
      ) : null}

      {spec ? (
        <Section title={`Especificación (revisión ${spec.revision})`}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{spec.sistema.objetivo}</CardTitle>
              <CardDescription>
                {spec.casos_uso.length} casos de uso · {spec.criterios} criterios
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <List items={spec.casos_uso.map((u) => `${u.id} · ${u.nombre}: ${u.objetivo}`)} />
              {spec.problemas.length ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {spec.problemas.length} problema(s): {spec.problemas.map((p) => p.message).join('; ')}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          {spec.preguntas.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {spec.preguntas.map((p) => (
                <SpecQuestion key={p.id} q={p} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      {plan ? (
        <Section title={`Plan (revisión ${plan.revision})`} actions={plan.aprobado ? <StatusBadge tone="ok">aprobado</StatusBadge> : null}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {plan.tareas.length} tareas en {plan.olas.length} olas
              </CardTitle>
              <CardDescription>
                ~{plan.estimacion.minutos_en_paralelo} min con {plan.estimacion.paralelo} agentes ({plan.estimacion.minutos_en_serie} en serie) · {Math.round(plan.estimacion.tokens_total / 1000)}k
                tokens estimados
                {plan.estimacion.costo_equivalente_usd === null ? '' : ` · ≈US$ ${plan.estimacion.costo_equivalente_usd.toFixed(2)}`} (sin calibrar)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-mono text-xs text-muted-foreground">
                Perfil: {plan.perfil.stack.join(', ')} · test: {plan.perfil.comandos.test ? [plan.perfil.comandos.test.executable, ...plan.perfil.comandos.test.args].join(' ') : '—'}
              </p>
              {plan.olas.map((ola, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: waves are positional.
                <p key={i}>
                  <span className="font-medium">Ola {i + 1}:</span> {ola.map((id) => `${id} ${plan.tareas.find((x) => x.id === id)?.titulo ?? ''}`).join(' · ')}
                </p>
              ))}
              {plan.supuestos.length ? (
                <>
                  <p className="pt-2 font-medium">Supuestos</p>
                  <List items={plan.supuestos} />
                </>
              ) : null}
            </CardContent>
            <CardFooter className="flex-col items-start gap-2">
              {plan.problemas_para_aprobar.length ? (
                <p className="text-sm text-destructive">Para aprobar falta: {plan.problemas_para_aprobar.map((x) => (typeof x === 'string' ? x : x.mensaje)).join('; ')}</p>
              ) : null}
              {!plan.aprobado && d.cambio.fase === 'aprobar' && !plan.problemas_para_aprobar.length ? (
                <Button onClick={() => void run('/v1/plan/aprobar', {}, { confirm: '¿Aprobar exactamente este plan, esta especificación y esta política?' })}>Aprobar plan</Button>
              ) : null}
            </CardFooter>
          </Card>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tarea</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="hidden md:table-cell">Depende de</TableHead>
                  <TableHead className="hidden md:table-cell">Escribe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.tareas.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-72 truncate">
                      <span className="font-medium">{t.id}</span> {t.titulo}
                    </TableCell>
                    <TableCell>
                      {t.tipo} · {t.complejidad}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{t.depende_de.join(', ') || '—'}</TableCell>
                    <TableCell className="hidden max-w-64 truncate md:table-cell">
                      <Mono>{t.escribe.join(', ')}</Mono>
                    </TableCell>
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
