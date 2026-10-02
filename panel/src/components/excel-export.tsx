import { FileSpreadsheetIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api';

const KEY = 'forja:excel';

function remembered(): { iniciativa: string; contingencia: string } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { iniciativa?: string; contingencia?: string };
    return { iniciativa: v.iniciativa ?? 'INI001', contingencia: v.contingencia ?? '15' };
  } catch {
    return { iniciativa: 'INI001', contingencia: '15' };
  }
}

/**
 * «Excel de requerimientos»: the project's sprints as the requirements workbook
 * (process map, DER, final stories with the estimate, tasks), to organize sprints.
 */
export function ExcelExportButton({ variant = 'outline' }: { variant?: 'outline' | 'default' }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(remembered);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_-]{1,20}$/.test(form.iniciativa) && Number(form.contingencia) >= 0 && Number(form.contingencia) <= 100;
  const download = async () => {
    setBusy(true);
    try {
      try {
        localStorage.setItem(KEY, JSON.stringify(form));
      } catch {
        // Without storage the choice lasts until the page reloads.
      }
      const q = new URLSearchParams({ iniciativa: form.iniciativa.toUpperCase(), contingencia: String(Number(form.contingencia)) });
      const { name, blob } = await api.download(`/v1/historial/excel?${q}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Descargado: ${name}`);
      setOpen(false);
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <FileSpreadsheetIcon /> Excel de requerimientos
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excel de requerimientos</DialogTitle>
            <DialogDescription>
              Mapa de procesos (un subproceso por sprint), DER con épicas e historias y su estado, épicas y HU finales para estimar en horas, tareas y entidades. Las horas las completas tú en el
              Excel.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="xl-ini">Código de iniciativa</Label>
              <Input id="xl-ini" value={form.iniciativa} onChange={(e) => setForm({ ...form, iniciativa: e.target.value.trim() })} placeholder="INI001" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="xl-cont">Contingencia (%)</Label>
              <Input id="xl-cont" inputMode="decimal" value={form.contingencia} onChange={(e) => setForm({ ...form, contingencia: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Códigos: {form.iniciativa.toUpperCase() || 'INI001'}_P01_E01_HU01 (subproceso = sprint, épica = capacidad, HU = caso de uso).</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={!valid || busy} onClick={() => void download()}>
              <FileSpreadsheetIcon /> {busy ? 'Generando…' : 'Descargar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
