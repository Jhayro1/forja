import { ChevronDownIcon, PlusIcon, Undo2Icon } from 'lucide-react';
import { useApp } from '@/app/context';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAction } from '@/hooks/use-api';
import type { Planeacion } from '@/lib/types';

/** What each move does, said before it happens (flujo/PLAN.md §3): nothing is deleted. */
const MOVE: Record<string, { label: string; title: string; description: string; destructive?: boolean }> = {
  descubrir: {
    label: 'Volver a la conversación',
    title: '¿Volver a la conversación?',
    description:
      'Sigues conversando con el planeador para cambiar lo inicial. La especificación y el plan se guardan como base; el plan deja de estar aprobado. Al aprobar de nuevo sólo se rehace lo que cambie.',
  },
  especificar: {
    label: 'Volver a la especificación',
    title: '¿Volver a la especificación?',
    description: 'Puedes pedir cambios o editar casos de uso. El plan se guarda, pero deja de estar aprobado hasta que vuelvas a dividir y aprobar.',
  },
  dividir: {
    label: 'Volver a dividir en tareas',
    title: '¿Volver a dividir en tareas?',
    description: 'El plan actual se guarda y deja de estar aprobado. Las tareas ya integradas se heredan si no cambian.',
  },
  cancelado: {
    label: 'Cancelar el sprint',
    title: '¿Cancelar este sprint?',
    description: 'Queda todo registrado (conversación, especificación, plan y avance) y lo puedes reactivar cuando quieras.',
    destructive: true,
  },
};

/** Sprint picker + «Nuevo sprint»: several sprints live at once; the panel works on the selected one. */
export function SprintSwitcher({ pl, onNew, onSelect }: { pl: Planeacion; onNew: () => void; onSelect: () => void }) {
  const { run } = useAction();
  const { textos } = useApp();
  const phase = new Map<string, string>([...textos.fases, ...(textos.fases_extra ?? [])]);
  const sprints = pl.sprints ?? [];
  const current = sprints.find((s) => s.seleccionado)?.id;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {sprints.length > 1 ? (
        <Select
          value={current}
          onValueChange={async (id) => {
            if (await run('/v1/planeacion/sprint', { cambio: id }, { quiet: true })) onSelect();
          }}
        >
          <SelectTrigger className="h-8 w-72 text-xs" aria-label="Sprint">
            <SelectValue placeholder="Elige un sprint" />
          </SelectTrigger>
          <SelectContent>
            {sprints.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                <span className="truncate">{s.titulo}</span>
                <span className="ml-2 text-muted-foreground">· {phase.get(s.fase) ?? s.fase}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Button size="sm" variant="outline" onClick={onNew}>
        <PlusIcon /> Nuevo sprint
      </Button>
    </div>
  );
}

/** Back to an earlier phase, cancel or reactivate the selected sprint. */
export function PhaseActions({ pl }: { pl: Planeacion }) {
  const { run } = useAction();
  const moves = pl.cambio?.movimientos ?? [];
  if (!moves.length) return null;
  const go = (to: string) => {
    const m = MOVE[to];
    const reactivate = pl.cambio?.fase === 'cancelado';
    void run(
      '/v1/planeacion/mover',
      { a: to },
      {
        confirm: reactivate
          ? { title: '¿Reactivar este sprint?', description: 'Vuelve a la conversación con todo lo que tenía.', confirm: 'Reactivar' }
          : { title: m?.title ?? `¿Pasar a ${to}?`, description: m?.description ?? '', confirm: m?.label ?? 'Seguir', ...(m?.destructive ? { destructive: true } : {}) },
      },
    );
  };
  if (pl.cambio?.fase === 'cancelado')
    return (
      <Button size="sm" onClick={() => go('descubrir')}>
        <Undo2Icon /> Reactivar
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Undo2Icon /> Volver o cancelar <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {moves.map((to) => (
          <DropdownMenuItem key={to} onSelect={() => go(to)} className={MOVE[to]?.destructive ? 'text-destructive' : undefined}>
            {MOVE[to]?.label ?? to}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
