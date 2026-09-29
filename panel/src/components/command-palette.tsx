import { FlagIcon, PlayIcon, PlusIcon, ShieldCheckIcon, SquareIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useApp } from '@/app/context';
import { NAV } from '@/app/navigation';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { EstadoV3 } from '@/lib/types';

/**
 * ⌘K / Ctrl+K: go to any screen, open a task by id, and the actions that are possible
 * right now (the server still checks each one: this only saves clicks).
 */
export function CommandPalette({ open, onOpenChange, onOpenTask }: { open: boolean; onOpenChange: (o: boolean) => void; onOpenTask: (id: string) => void }) {
  const { go, has, project } = useApp();
  const { run } = useAction();
  const est = useApiQuery<{ estado: EstadoV3 }>(open && project && has('runs') ? '/v1/estado' : null);
  const e = est.data?.estado;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key.toLowerCase() === 'k' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const close = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const phase = e?.cambio?.fase;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Buscar y ejecutar" description="Ir a una pantalla, abrir una tarea o lanzar una acción">
      <CommandInput placeholder="Escribe una pantalla, una tarea (T-003) o una acción…" />
      <CommandList>
        <CommandEmpty>Nada coincide.</CommandEmpty>
        <CommandGroup heading="Ir a">
          {NAV.filter((n) => has(n.module)).map((n) => (
            <CommandItem key={n.id} value={`${n.title} ${n.hint}`} onSelect={close(() => go(n.id))}>
              <n.icon /> {n.title}
              <span className="ml-2 truncate text-xs text-muted-foreground">{n.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {e ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Acciones">
              {phase === 'aprobar' && !e.run ? (
                <CommandItem value="aprobar plan" onSelect={close(() => void run('/v1/plan/aprobar', {}, { confirm: '¿Aprobar exactamente este plan?' }))}>
                  <FlagIcon /> Aprobar el plan
                </CommandItem>
              ) : null}
              {(phase === 'aprobar' || phase === 'ejecutar') && !e.run?.activo ? (
                <CommandItem value="ejecutar run" onSelect={close(() => void run('/v1/trabajos', { tipo: 'run' }, { confirm: { title: '¿Ejecutar el plan?', confirm: 'Ejecutar' } }))}>
                  <PlayIcon /> Ejecutar o retomar el plan
                </CommandItem>
              ) : null}
              {e.run?.activo ? (
                <CommandItem
                  value="detener run"
                  onSelect={close(
                    () => void run('/v1/run/detener', {}, { confirm: { title: '¿Detener el run?', description: 'Las tareas en curso terminan en orden.', destructive: true, confirm: 'Detener' } }),
                  )}
                >
                  <SquareIcon /> Detener el run
                </CommandItem>
              ) : null}
              {phase === 'entregado' && has('trabajo') ? (
                <CommandItem
                  value="validar qa auditoria"
                  onSelect={close(() => void run('/v1/trabajos', { tipo: 'validar' }, { confirm: { title: '¿Validar el sprint con QA y auditoría?', confirm: 'Validar' } }))}
                >
                  <ShieldCheckIcon /> Validar el sprint (QA y auditoría)
                </CommandItem>
              ) : null}
              <CommandItem value="nuevo sprint idea" onSelect={close(() => go('sprint'))}>
                <PlusIcon /> Nueva idea o sprint
              </CommandItem>
            </CommandGroup>
            {e.tareas.length ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Tareas">
                  {e.tareas.map((t) => (
                    <CommandItem key={t.id} value={`${t.id} ${t.titulo}`} onSelect={close(() => onOpenTask(t.id))}>
                      <span className="font-mono text-xs">{t.id}</span> <span className="truncate">{t.titulo}</span>
                      <CommandShortcut>{t.estado}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
