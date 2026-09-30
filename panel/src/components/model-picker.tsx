import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CatalogModel, Effort } from '@/lib/types';

const NONE = '__ninguno__';
const OTHER = '__otro__';
const DEFAULT = '__defecto__';
const PROVIDERS: [CatalogModel['proveedor'], string][] = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
];
const TIER: Record<CatalogModel['nivel'], string> = { tope: '$$$$', alto: '$$$', medio: '$$', economico: '$' };

function ModelLabel({ m }: { m: CatalogModel }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{m.nombre}</span>
      <span className="font-mono text-xs text-muted-foreground">{m.ref.split(':')[1]}</span>
      {m.estado === 'retirandose' ? <span className="text-xs text-destructive">se retira {m.se_retira}</span> : null}
    </span>
  );
}

/**
 * Every model of both CLIs, grouped by provider, plus «Otro» to type any
 * `proveedor:modelo` the catalog does not know yet.
 */
export function ModelPicker({
  id,
  value,
  onChange,
  models,
  optional,
  label,
  noneLabel = 'Ninguno',
  className,
}: {
  id: string;
  value: string;
  onChange: (ref: string) => void;
  models: CatalogModel[];
  optional?: boolean;
  label: string;
  /** What «no model» means here (e.g. «Predeterminado (claude:opus)»). */
  noneLabel?: string;
  className?: string;
}) {
  const known = models.some((m) => m.ref === value);
  const [typing, setTyping] = useState(Boolean(value) && !known);
  const selected = typing ? OTHER : value || (optional ? NONE : '');
  return (
    <div className="grid gap-2">
      <Select
        value={selected}
        onValueChange={(v) => {
          if (v === OTHER) {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(v === NONE ? '' : v);
        }}
      >
        <SelectTrigger id={id} aria-label={label} className={className ?? 'w-full'}>
          <SelectValue placeholder="Elige un modelo" />
        </SelectTrigger>
        <SelectContent className="max-h-96">
          {optional ? (
            <>
              <SelectItem value={NONE}>{noneLabel}</SelectItem>
              <SelectSeparator />
            </>
          ) : null}
          {PROVIDERS.map(([provider, title]) => (
            <SelectGroup key={provider}>
              <SelectLabel>{title}</SelectLabel>
              {models
                .filter((m) => m.proveedor === provider)
                .map((m) => (
                  <SelectItem key={m.ref} value={m.ref} textValue={m.nombre}>
                    <ModelLabel m={m} />
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">{TIER[m.nivel]}</span>
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
          <SelectSeparator />
          <SelectItem value={OTHER}>Otro (escribir proveedor:modelo)…</SelectItem>
        </SelectContent>
      </Select>
      {typing ? <Input aria-label={`${label}: modelo escrito a mano`} placeholder="claude:claude-opus-5-5 o codex:gpt-6-sol" value={value} onChange={(e) => onChange(e.target.value.trim())} /> : null}
    </div>
  );
}

/** Effort levels, marking which ones the chosen model accepts (the rest are clamped). */
export function EffortPicker({
  id,
  value,
  onChange,
  efforts,
  model,
  defaultLabel = 'Por defecto del CLI',
  className,
  label,
}: {
  id: string;
  value: Effort | null;
  onChange: (e: Effort | null) => void;
  efforts: { id: Effort; nombre: string }[];
  model: CatalogModel | undefined;
  defaultLabel?: string;
  className?: string;
  label?: string;
}) {
  const accepted = model?.esfuerzos;
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : (v as Effort))}>
      <SelectTrigger id={id} className={className ?? 'w-full'} {...(label ? { 'aria-label': label } : {})}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        <SelectSeparator />
        {efforts.map((e) => (
          <SelectItem key={e.id} value={e.id}>
            <span>{e.nombre}</span>
            <span className="font-mono text-xs text-muted-foreground">{e.id}</span>
            {accepted && !accepted.includes(e.id) ? <span className="text-xs text-muted-foreground">(este modelo usa el más cercano)</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
