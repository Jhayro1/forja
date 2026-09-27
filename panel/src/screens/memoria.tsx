import { SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, LogBlock, Mono, PageHeader, Section } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { api } from '@/lib/api';
import type { Memoria as Data, Nodo } from '@/lib/types';

const stat = (o: Record<string, number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ') || '—';

export default function Memoria() {
  const q = useApiQuery<{ memoria: Data }>('/v1/memoria');
  const { run } = useAction();
  const [text, setText] = useState('');
  const [found, setFound] = useState<Nodo[] | null>(null);
  const search = async () => {
    try {
      setFound((await api.get<{ nodos: Nodo[] }>(`/v1/memoria/buscar?q=${encodeURIComponent(text.trim())}`)).nodos);
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    }
  };
  const d = q.data?.memoria;
  if (!d) return <PageHeader title="Memoria del proyecto" description="Cargando…" />;
  const pending = d.lecciones.filter((l) => l.state === 'propuesta');
  return (
    <div className="space-y-10">
      <PageHeader title="Memoria del proyecto" description={`Contexto de los agentes: ${d.modo === 'grafo' ? 'grafo (archivos relacionados con motivo)' : 'simple (lo que declara cada tarea)'}`} />
      <Card>
        <CardHeader>
          <CardDescription>
            {d.construido ? (
              <>
                Índice construido {d.construido.slice(0, 16).replace('T', ' ')} UTC{d.fuente ? ` desde ${d.fuente}` : ''} · se reconstruye con <Mono>forja memoria construir</Mono>
              </>
            ) : (
              <>
                Todavía no hay índice: <Mono>forja memoria construir</Mono>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">nodos</dt>
            <dd>{stat(d.grafo.nodos)}</dd>
            <dt className="text-muted-foreground">aristas</dt>
            <dd>{stat(d.grafo.aristas)}</dd>
            <dt className="text-muted-foreground">posibles</dt>
            <dd>{d.grafo.posibles} (inferidas, no demostradas)</dd>
          </dl>
        </CardContent>
      </Card>

      <Section title={`Lecciones por revisar (${pending.length})`}>
        {pending.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {pending.map((l) => (
              <Card key={l.lesson_id} className="gap-3 border-warning/40">
                <CardHeader>
                  <CardTitle className="text-sm">{l.lesson_id}</CardTitle>
                  <CardDescription>{l.text}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Mono className="text-xs text-muted-foreground">{JSON.stringify(l.evidence)}</Mono>
                </CardContent>
                <CardFooter className="gap-2">
                  <Button size="sm" onClick={() => void run(`/v1/memoria/lecciones/${l.lesson_id}/aprobar`, { nota: 'aprobada desde el panel' })}>
                    Aprobar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void run(`/v1/memoria/lecciones/${l.lesson_id}/rechazar`, { nota: 'rechazada desde el panel' })}>
                    Rechazar
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nada que revisar. Las lecciones aprobadas se muestran a las tareas de su ámbito, nunca como reglas.</p>
        )}
      </Section>

      <Section title="Buscar en el grafo">
        <div className="flex max-w-xl gap-2">
          <Input
            placeholder="Buscar: UC-001, saldo, src/api.ts…"
            aria-label="Buscar en el grafo"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
          />
          <Button onClick={() => void search()}>
            <SearchIcon /> Buscar
          </Button>
        </div>
        {found === null ? null : found.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {found.map((n) => (
              <Card key={n.id} className="gap-3">
                <CardHeader>
                  <CardTitle className="text-sm">
                    <Mono>{n.id}</Mono> ({n.kind}) {n.label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <LogBlock
                    lines={[
                      ...n.salen.map((e) => `→ ${e.kind} ${e.dst}${e.confidence === 'posible' ? ' (posible)' : ''}`),
                      ...n.entran.map((e) => `← ${e.kind} ${e.src}${e.confidence === 'posible' ? ' (posible)' : ''}`),
                    ]}
                    empty="(sin relaciones)"
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState title="Sin resultados" />
        )}
      </Section>
    </div>
  );
}
