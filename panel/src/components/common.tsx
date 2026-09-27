import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center">
      {icon ? <div className="text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function Field({ label, htmlFor, help, children }: { label: string; htmlFor?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[0.85em]', className)}>{children}</span>;
}

/** Output of a CLI or a log: monospace, scrollable, never rendered as HTML. */
export function LogBlock({ lines, className, empty = 'Sin salida todavía…' }: { lines: string[]; className?: string; empty?: string }) {
  return <pre className={cn('max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap', className)}>{lines.length ? lines.join('\n') : empty}</pre>;
}

type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted';
const TONES: Record<Tone, string> = {
  ok: 'border-success/30 bg-success/10 text-success',
  warn: 'border-warning/40 bg-warning/15 text-foreground',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-brand/30 bg-brand/10 text-foreground',
  muted: 'text-muted-foreground',
};

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn('font-medium', TONES[tone])}>
      {children}
    </Badge>
  );
}

const TASK_TONE: Record<string, Tone> = {
  integrada: 'ok',
  verificada: 'ok',
  ejecutando: 'info',
  reservada: 'info',
  verificando: 'info',
  integrando: 'info',
  esperando_respuesta: 'warn',
  pausada: 'warn',
  bloqueada: 'error',
};

export function taskTone(estado: string): Tone {
  return TASK_TONE[estado] ?? 'muted';
}
