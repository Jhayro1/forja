import { BotIcon, PlayIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/context';
import { Mono } from '@/components/common';
import { ModelPicker } from '@/components/model-picker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { Configuracion, TareaV3 } from '@/lib/types';

const DONE = ['integrada', 'cancelada', 'invalidada'];

/**
 * «Ejecutar con un agente» (ligera/PLAN.md F4): the user picks the tasks — or all of them —
 * and who does them. One agent goes through them in order, in the same session; Forja adds
 * any dependency that is missing and stops at the first task that needs the user.
 */
export function BlockRunDialog({ open, onOpenChange, tasks }: { open: boolean; onOpenChange: (open: boolean) => void; tasks: TareaV3[] }) {
  const { ligera } = useApp();
  const pending = useMemo(() => tasks.filter((t) => !DONE.includes(t.estado)), [tasks]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pending.map((t) => t.id)));
  const [model, setModel] = useState('');
  const cfg = useApiQuery<{ configuracion: Configuracion }>(open ? '/v1/configuracion' : null);
  // Each time it opens: every pending task selected, as the default «do the rest».
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens
  useEffect(() => {
    if (open) setPicked(new Set(pending.map((t) => t.id)));
  }, [open]);
  const { run, busy } = useAction();
  const suggested = cfg.data?.configuracion.roles.find((r) => r.rol === 'trabajador')?.modelos[0] ?? null;
  const all = picked.size === pending.length && pending.length > 0;
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const start = async () => {
    const ids = pending.filter((t) => picked.has(t.id)).map((t) => t.id);
    const r = await run('/v1/trabajos/bloque', { tareas: ids, modelo: model || null });
    if (r) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotIcon className="size-5" /> Ejecutar con un agente
          </DialogTitle>
          <DialogDescription>
            Un solo agente hace las tareas que elijas, una tras otra y en la misma sesión: recuerda lo que hizo en las anteriores. Si falta una dependencia, Forja la agrega; si una tarea falla, se
            detiene y te pregunta.
            {ligera ? ' Corre directo en tu equipo con tus sesiones de Claude y Codex: trabaja en su propia rama, nunca en la principal.' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="bloque-modelo">¿Quién lo hace?</Label>
            {cfg.data ? (
              <ModelPicker
                id="bloque-modelo"
                label="Modelo del bloque"
                value={model}
                onChange={setModel}
                models={cfg.data.configuracion.catalogo.modelos.filter((m) => m.estado !== 'retirandose')}
                optional
              />
            ) : (
              <p className="text-sm text-muted-foreground">Cargando modelos…</p>
            )}
            <p className="text-xs text-muted-foreground">Sin elegir: el de cada rol en Configuración{suggested ? ` (hoy ${suggested})` : ''}.</p>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Checkbox id="bloque-todas" checked={all} onCheckedChange={(v) => setPicked(v === true ? new Set(pending.map((t) => t.id)) : new Set())} aria-label="Todas las tareas pendientes" />
              <Label htmlFor="bloque-todas">Todas las pendientes ({pending.length})</Label>
            </div>
            <ScrollArea className="max-h-72 rounded-md border">
              <ul className="divide-y">
                {pending.map((t) => (
                  <li key={t.id} className="flex items-start gap-2 px-3 py-2">
                    <Checkbox id={`bloque-${t.id}`} checked={picked.has(t.id)} onCheckedChange={(v) => toggle(t.id, v === true)} className="mt-0.5" />
                    <Label htmlFor={`bloque-${t.id}`} className="block font-normal leading-snug">
                      <Mono className="text-muted-foreground">{t.id}</Mono> {t.titulo}
                      {t.depende_de?.length ? <span className="block text-xs text-muted-foreground">depende de {t.depende_de.join(', ')}</span> : null}
                    </Label>
                  </li>
                ))}
                {!pending.length ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No quedan tareas pendientes.</li> : null}
              </ul>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void start()} disabled={picked.size === 0 || busy !== null}>
            <PlayIcon /> Empezar ({picked.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
