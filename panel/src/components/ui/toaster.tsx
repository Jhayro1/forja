import { CircleAlertIcon, CircleCheckIcon, XIcon } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

// Avisos al estilo shadcn sobre Radix Toast. No usamos sonner: inyecta un <style> y la CSP
// del panel sólo acepta hojas de estilo propias.

type Item = { id: number; text: string; kind: 'ok' | 'error'; ms: number };

let items: Item[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function toast(text: string, kind: Item['kind'] = 'ok', ms = kind === 'error' ? 8000 : 4000): void {
  items = [...items, { id: ++seq, text, kind, ms }].slice(-4);
  emit();
}

function dismiss(id: number): void {
  items = items.filter((i) => i.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {list.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          duration={t.ms}
          onOpenChange={(open) => !open && dismiss(t.id)}
          className={cn(
            'group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border bg-popover p-4 pr-8 text-sm text-popover-foreground shadow-lg',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:animate-out data-[state=closed]:fade-out-80',
            t.kind === 'error' && 'border-destructive/40',
          )}
        >
          {t.kind === 'error' ? <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" /> : <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />}
          <ToastPrimitive.Description className="whitespace-pre-line">{t.text}</ToastPrimitive.Description>
          <ToastPrimitive.Close aria-label="Cerrar" className="absolute top-3 right-3 rounded-sm opacity-60 hover:opacity-100">
            <XIcon className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-sm" />
    </ToastPrimitive.Provider>
  );
}
