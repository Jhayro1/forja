import { cn } from '@/lib/utils';

/** Each forja.yaml role belongs to one of the six roles of v3 §4, with its own colour (always with text). */
export const ROLE_OF: Record<string, { label: string; className: string }> = {
  planeador: { label: 'Orquestador', className: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  trabajador: { label: 'Implementador', className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  complejo: { label: 'Implementador+', className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  integrador: { label: 'Integrador', className: 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300' },
  revisor: { label: 'Revisor', className: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300' },
  auditor: { label: 'Auditor', className: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  qa: { label: 'QA', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
};

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  const r = ROLE_OF[role] ?? { label: role, className: 'text-muted-foreground' };
  return <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium', r.className, className)}>{r.label}</span>;
}
