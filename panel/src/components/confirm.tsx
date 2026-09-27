import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

export type ConfirmOptions = { title: string; description?: string; confirm?: string; destructive?: boolean };
type Confirm = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(async () => false);

/** `const confirm = useConfirm(); if (await confirm('¿Seguro?')) …` with a shadcn AlertDialog. */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const confirm = useCallback<Confirm>((o) => {
    setOptions(typeof o === 'string' ? { title: o } : o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const close = (value: boolean) => {
    resolver.current(value);
    setOptions(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => !open && close(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description ? <AlertDialogDescription className="whitespace-pre-line">{options.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>Cancelar</AlertDialogCancel>
            <AlertDialogAction className={options?.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined} onClick={() => close(true)}>
              {options?.confirm ?? 'Seguir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
