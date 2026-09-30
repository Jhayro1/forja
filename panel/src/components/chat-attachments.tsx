import { FileTextIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { type DragEvent, type ReactNode, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';

/** A document attached to the next message to the planner (same limits as planner/attachments.ts). */
export type Attachment = { nombre: string; contenido: string; bytes: number };

const TEXT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.sql',
  '.xml',
  '.html',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.cs',
  '.php',
  '.rb',
  '.kt',
  '.swift',
  '.toml',
  '.ini',
  '.feature',
  '.mmd',
  '.puml',
];
const MAX_BYTES = 512 * 1024;
export const MAX_FILES = 10;

const isText = (name: string) => TEXT_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** Reads dropped or picked files; what cannot go (binary, too big, repeated) is explained, not silently dropped. */
export async function readFiles(list: FileList | File[], current: Attachment[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of Array.from(list)) {
    if (current.length + out.length >= MAX_FILES) {
      toast(`Como máximo ${MAX_FILES} documentos por mensaje`, 'error');
      break;
    }
    if (!isText(f.name)) {
      toast(`«${f.name}» no es un documento de texto (.md, .txt, .json, .sql…)`, 'error');
      continue;
    }
    if (f.size > MAX_BYTES) {
      toast(`«${f.name}» pesa más de 512 KB`, 'error');
      continue;
    }
    if ([...current, ...out].some((a) => a.nombre.toLowerCase() === f.name.toLowerCase())) continue;
    out.push({ nombre: f.name, contenido: await f.text(), bytes: f.size });
  }
  return out;
}

/** Chip of one document; with `onRemove` it can be taken out before sending. */
export function AttachmentChip({ name, bytes, onRemove, inverted }: { name: string; bytes?: number; onRemove?: () => void; inverted?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
        inverted ? 'border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground' : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      )}
    >
      <FileTextIcon className="size-3.5 shrink-0" />
      <span className="truncate font-medium">{name}</span>
      {bytes !== undefined ? <span className="opacity-70">{kb(bytes)}</span> : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} className="rounded-sm opacity-70 hover:opacity-100" aria-label={`Quitar ${name}`}>
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Message text with the names of its documents in blue: «@plan.md» (or the bare name)
 * is highlighted when it is one of the attached files. Plain text only: no HTML is built.
 */
export function TextWithDocs({ text, docs, inverted }: { text: string; docs: string[]; inverted?: boolean }) {
  if (!docs.length) return <>{text}</>;
  const names = [...docs].sort((a, b) => b.length - a.length).map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(@?(?:${names.join('|')}))`, 'g');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    parts.push(
      <span key={i} className={cn('font-medium', inverted ? 'text-sky-200 underline decoration-sky-200/60' : 'text-sky-600 dark:text-sky-400')}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/**
 * Drop zone around the message box, plus a paperclip button. A dropped document is
 * added as a chip and named in the text as @nombre, where it shows in blue once sent.
 */
export function AttachmentDropZone({ files, onAdd, disabled, children }: { files: Attachment[]; onAdd: (added: Attachment[]) => void; disabled?: boolean; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = async (list: FileList | File[]) => {
    const added = await readFiles(list, files);
    if (added.length) onAdd(added);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled && e.dataTransfer.files.length) void add(e.dataTransfer.files);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target wraps the textarea; the paperclip button is the keyboard path.
    <div
      className={cn('relative rounded-md', over && 'ring-2 ring-sky-500 ring-offset-2 ring-offset-background')}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-sky-500/10 text-sm font-medium text-sky-700 dark:text-sky-300">
          Suelta aquí tus documentos (.md, .txt, .json…)
        </div>
      ) : null}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        accept={TEXT_EXTENSIONS.join(',')}
        onChange={(e) => {
          if (e.target.files) void add(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1.5 bottom-1.5 size-8 text-muted-foreground"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Adjuntar documentos"
        title="Adjuntar documentos (o arrástralos al cuadro)"
      >
        <PaperclipIcon />
      </Button>
    </div>
  );
}
