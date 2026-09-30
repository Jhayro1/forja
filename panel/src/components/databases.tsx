import { CheckIcon, DatabaseIcon, LinkIcon, PencilIcon, PlugZapIcon, PlusIcon, ShieldAlertIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, Mono, Section, StatusBadge } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { fechaHora } from '@/lib/format';

type Conexion = {
  name: string;
  motor: 'mysql' | 'postgres';
  host: string;
  port: number;
  bases: string[];
  usuario: string;
  ssl: boolean;
  variables_nombres: string[];
  version: number;
  tiene_clave: boolean;
};
type Vinculo = { conn: string; bases: string[]; lectura: 'preguntar' | 'libre'; pruebas: boolean; active: boolean };
type Tabla = { conn: string; base: string; name: string; created_by: string; created_at: string; dropped_at: string | null };
type Solicitud = {
  req_id: string;
  conn: string;
  base: string;
  kind: 'lectura' | 'crear' | 'cambio';
  sql: string;
  motivo: string | null;
  para_que: string | null;
  origin: string;
  state: 'pendiente' | 'bloqueada' | 'rechazada' | 'ejecutada' | 'fallida';
  detail: string | null;
  created_at: string;
  filas: number | null;
  resultado: { columns: string[]; rows: unknown[][]; truncated: boolean; affected: number | null } | null;
};
type Bases = { conexiones: Conexion[]; vinculos: Vinculo[]; tablas_creadas: Tabla[]; solicitudes: Solicitud[] };

type Form = { nombre: string; motor: 'mysql' | 'postgres'; host: string; puerto: string; bases: string; usuario: string; clave: string; ssl: boolean; variables: string };
const EMPTY: Form = { nombre: '', motor: 'mysql', host: '', puerto: '3306', bases: '', usuario: '', clave: '', ssl: false, variables: '' };

const KIND: Record<Solicitud['kind'], string> = { lectura: 'Consulta', crear: 'Crear tabla', cambio: 'Cambio' };
const STATE_TONE = { pendiente: 'warn', bloqueada: 'error', rechazada: 'muted', ejecutada: 'ok', fallida: 'error' } as const;

function toBody(f: Form) {
  return {
    nombre: f.nombre.trim(),
    motor: f.motor,
    host: f.host.trim(),
    puerto: Number(f.puerto),
    bases: f.bases
      .split(/[,\s]+/)
      .map((b) => b.trim())
      .filter(Boolean),
    usuario: f.usuario.trim(),
    ...(f.clave ? { clave: f.clave } : {}),
    ssl: f.ssl,
    ...(f.variables.trim() ? { variables: f.variables } : {}),
  };
}

/** Register or edit a connection: paste what you have (a JDBC URL or your variables) and Forja fills the form. */
function ConnectionDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (v: boolean) => void; editing: Conexion | null }) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [pasted, setPasted] = useState('');
  const [tests, setTests] = useState<{ base: string; ok: boolean; detalle: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { run } = useAction();
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setForm(
        editing
          ? {
              nombre: editing.name,
              motor: editing.motor,
              host: editing.host,
              puerto: String(editing.port),
              bases: editing.bases.join(', '),
              usuario: editing.usuario,
              clave: '',
              ssl: editing.ssl,
              variables: '',
            }
          : EMPTY,
      );
      setPasted('');
      setTests(null);
    }
  }
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const analyze = async () => {
    if (!pasted.trim()) return;
    try {
      const r = await api.post<{
        sugerencia: Partial<{ motor: Form['motor']; host: string; puerto: number; bases: string[]; ssl: boolean; usuario: string; clave: string; variables: string }>;
        avisos?: string[];
      }>('/v1/bases/analizar', {
        texto: pasted,
      });
      const s = r.sugerencia;
      setForm((f) => ({
        ...f,
        ...(s.motor ? { motor: s.motor } : {}),
        ...(s.host ? { host: s.host } : {}),
        ...(s.puerto ? { puerto: String(s.puerto) } : {}),
        ...(s.bases?.length ? { bases: s.bases.join(', ') } : {}),
        ...(s.ssl !== undefined ? { ssl: s.ssl } : {}),
        ...(s.usuario ? { usuario: s.usuario } : {}),
        ...(s.clave ? { clave: s.clave } : {}),
        ...(s.variables ? { variables: s.variables } : {}),
        nombre:
          f.nombre ||
          (s.bases?.[0]
            ? s.bases[0]
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/^[^a-z]+/, 'bd-')
            : f.nombre),
      }));
      toast(r.avisos?.length ? `Formulario completado · ${r.avisos.join('; ')}` : 'Formulario completado: revísalo y prueba la conexión');
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    }
  };
  const test = async () => {
    setBusy(true);
    setTests(null);
    try {
      const r = await api.post<{ resultados: { base: string; ok: boolean; detalle: string }[] }>('/v1/bases/probar', toBody(form));
      setTests(r.resultados);
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (await run('/v1/bases', toBody(form))) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-5" /> {editing ? `Editar «${editing.name}»` : 'Nueva conexión de base de datos'}
          </DialogTitle>
          <DialogDescription>La clave y las variables se guardan cifradas en esta máquina. Ningún agente las recibe: Forja ejecuta lo que tus reglas permiten.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="bd-pegar">Pega lo que tengas (opcional)</Label>
          <Textarea
            id="bd-pegar"
            rows={4}
            className="font-mono text-xs"
            placeholder={'jdbc:mysql://host:3306/base?useSSL=false\n— o tus variables —\nAPP_URL_BASE: jdbc:mysql://host:3306/base\nAPP_DBUSER: usuario\nAPP_DBPASSWORD: clave'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <Button variant="outline" size="sm" className="w-fit" onClick={() => void analyze()} disabled={!pasted.trim()}>
            Completar el formulario con esto
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="bd-nombre">Nombre</Label>
            <Input id="bd-nombre" value={form.nombre} disabled={Boolean(editing)} placeholder="pruebas-facturacion" onChange={(e) => set('nombre', e.target.value.toLowerCase())} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bd-motor">Motor</Label>
            <Select
              value={form.motor}
              onValueChange={(v) => setForm((f) => ({ ...f, motor: v as Form['motor'], puerto: f.puerto === '3306' || f.puerto === '5432' ? (v === 'mysql' ? '3306' : '5432') : f.puerto }))}
            >
              <SelectTrigger id="bd-motor" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bd-host">Host</Label>
            <Input id="bd-host" value={form.host} placeholder="172.16.0.10" onChange={(e) => set('host', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bd-puerto">Puerto</Label>
            <Input id="bd-puerto" inputMode="numeric" value={form.puerto} onChange={(e) => set('puerto', e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="bd-bases">Bases (separadas por coma)</Label>
            <Input id="bd-bases" value={form.bases} placeholder="ventas, devventas" onChange={(e) => set('bases', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bd-usuario">Usuario</Label>
            <Input id="bd-usuario" autoComplete="off" value={form.usuario} onChange={(e) => set('usuario', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bd-clave">Clave</Label>
            <Input
              id="bd-clave"
              type="password"
              autoComplete="new-password"
              value={form.clave}
              placeholder={editing?.tiene_clave ? 'sin cambios (guardada)' : ''}
              onChange={(e) => set('clave', e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch id="bd-ssl" checked={form.ssl} onCheckedChange={(v) => set('ssl', v)} />
            <Label htmlFor="bd-ssl">Conectar con SSL/TLS</Label>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="bd-vars">Variables para las pruebas del proyecto (opcional)</Label>
            <Textarea
              id="bd-vars"
              rows={4}
              className="font-mono text-xs"
              placeholder={editing?.variables_nombres.length ? `sin cambios: ${editing.variables_nombres.join(', ')}` : 'NOMBRE: valor — las reciben sólo los comandos de prueba, nunca un agente'}
              value={form.variables}
              onChange={(e) => set('variables', e.target.value)}
            />
          </div>
        </div>

        {tests ? (
          <ul className="space-y-1 text-sm">
            {tests.map((t) => (
              <li key={t.base} className={t.ok ? 'text-success' : 'text-destructive'}>
                {t.ok ? '✔' : '✘'} <Mono>{t.base}</Mono> {t.detalle}
              </li>
            ))}
          </ul>
        ) : null}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => void test()} disabled={busy || !form.host || !form.bases}>
            <PlugZapIcon /> {busy ? 'Probando…' : 'Probar conexión'}
          </Button>
          <Button onClick={() => void save()} disabled={!form.nombre || !form.host || !form.bases || !form.usuario}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How this project uses a connection: which databases, whether reads need approval, and test variables. */
function LinkDialog({ conn, link, onOpenChange }: { conn: Conexion | null; link: Vinculo | undefined; onOpenChange: (v: boolean) => void }) {
  const [bases, setBases] = useState<string[]>([]);
  const [lectura, setLectura] = useState<'preguntar' | 'libre'>('preguntar');
  const [pruebas, setPruebas] = useState(false);
  const [lastConn, setLastConn] = useState<string | null>(null);
  const { run } = useAction();
  if ((conn?.name ?? null) !== lastConn) {
    setLastConn(conn?.name ?? null);
    if (conn) {
      setBases(link?.active ? link.bases : conn.bases);
      setLectura(link?.lectura ?? 'preguntar');
      setPruebas(link?.pruebas ?? false);
    }
  }
  if (!conn) return null;
  const save = async () => {
    if (await run(`/v1/bases/${conn.name}/vincular`, { bases, lectura, pruebas })) onOpenChange(false);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Usar «{conn.name}» en este proyecto</DialogTitle>
          <DialogDescription>
            Los agentes ven el esquema libremente. Crear tablas o cambiar datos siempre pasa por tu aprobación, y sólo sobre tablas que Forja creó: las que ya existían nunca se modifican.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Bases habilitadas</Label>
            {conn.bases.map((b) => (
              <div key={b} className="flex items-center gap-2">
                <Checkbox id={`vb-${b}`} checked={bases.includes(b)} onCheckedChange={(v) => setBases((x) => (v === true ? [...x, b] : x.filter((y) => y !== b)))} />
                <Label htmlFor={`vb-${b}`} className="font-mono font-normal">
                  {b}
                </Label>
              </div>
            ))}
          </div>
          <div className="grid gap-2">
            <Label>Consultas de lectura (SELECT)</Label>
            <RadioGroup value={lectura} onValueChange={(v) => setLectura(v as 'preguntar' | 'libre')}>
              <div className="flex items-start gap-2">
                <RadioGroupItem id="lec-preguntar" value="preguntar" className="mt-0.5" />
                <Label htmlFor="lec-preguntar" className="block font-normal">
                  Con mi aprobación <span className="block text-xs text-muted-foreground">Cada consulta te aparece en «Te necesita» antes de correr.</span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem id="lec-libre" value="libre" className="mt-0.5" />
                <Label htmlFor="lec-libre" className="block font-normal">
                  Sin preguntar <span className="block text-xs text-muted-foreground">Sólo lectura, hasta 200 filas: el agente puede ver datos de esta base.</span>
                </Label>
              </div>
            </RadioGroup>
          </div>
          <div className="flex items-start gap-2">
            <Switch id="vb-pruebas" checked={pruebas} onCheckedChange={setPruebas} disabled={!conn.variables_nombres.length} />
            <Label htmlFor="vb-pruebas" className="block font-normal">
              Pasar las variables a las pruebas del proyecto
              <span className="block text-xs text-muted-foreground">
                {conn.variables_nombres.length
                  ? `${conn.variables_nombres.join(', ')} — el código de las pruebas (que escriben los agentes) podrá usarlas.`
                  : 'Esta conexión no tiene variables guardadas.'}
              </span>
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!bases.length}>
            <LinkIcon /> Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestCard({ r }: { r: Solicitud }) {
  const { run } = useAction();
  const [why, setWhy] = useState('');
  return (
    <Card className="gap-3 border-warning/40">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone={r.kind === 'lectura' ? 'info' : 'warn'}>{KIND[r.kind]}</StatusBadge>
          <span>
            {r.conn} · <Mono>{r.base}</Mono>
          </span>
        </CardTitle>
        <CardDescription>
          {r.origin} · {fechaHora(r.created_at)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{r.sql}</pre>
        {r.motivo ? (
          <p>
            <span className="font-medium">Por qué:</span> {r.motivo}
          </p>
        ) : null}
        {r.para_que ? (
          <p>
            <span className="font-medium">Para qué:</span> {r.para_que}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void run(`/v1/bases/solicitudes/${r.req_id}/aprobar`, {}, { confirm: { title: '¿Aprobar y ejecutar?', description: r.sql.slice(0, 300), confirm: 'Aprobar' } })}
        >
          <CheckIcon /> Aprobar y ejecutar
        </Button>
        <Input className="h-8 max-w-60" placeholder="Motivo del rechazo (opcional)" aria-label="Motivo del rechazo" value={why} onChange={(e) => setWhy(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => void run(`/v1/bases/solicitudes/${r.req_id}/rechazar`, { motivo: why })}>
          <XIcon /> Rechazar
        </Button>
      </CardFooter>
    </Card>
  );
}

export function DatabasesSection() {
  const q = useApiQuery<{ bases: Bases }>('/v1/bases');
  const { run } = useAction();
  const [editing, setEditing] = useState<Conexion | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [linking, setLinking] = useState<Conexion | null>(null);
  const d = q.data?.bases;
  if (!d) return null;
  const linkOf = (name: string) => d.vinculos.find((l) => l.conn === name);
  const pending = d.solicitudes.filter((s) => s.state === 'pendiente');
  const history = d.solicitudes.filter((s) => s.state !== 'pendiente').slice(0, 30);

  return (
    <div className="space-y-8">
      <Section
        title="Bases de datos"
        description="Registra tu base de pruebas pegando la URL o tus variables. Los agentes ven el esquema; leer, crear o cambiar sigue tus reglas."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <PlusIcon /> Nueva conexión
          </Button>
        }
      >
        {d.conexiones.length ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Conexión</TableHead>
                  <TableHead>Servidor</TableHead>
                  <TableHead>Bases</TableHead>
                  <TableHead className="hidden md:table-cell">Usuario</TableHead>
                  <TableHead>En este proyecto</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.conexiones.map((c) => {
                  const l = linkOf(c.name);
                  return (
                    <TableRow key={c.name}>
                      <TableCell>
                        <span className="font-medium">{c.name}</span> <span className="text-xs text-muted-foreground">{c.motor === 'mysql' ? 'MySQL' : 'PostgreSQL'}</span>
                      </TableCell>
                      <TableCell>
                        <Mono>
                          {c.host}:{c.port}
                        </Mono>
                      </TableCell>
                      <TableCell className="max-w-48 truncate">
                        <Mono>{c.bases.join(', ')}</Mono>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {c.usuario} {c.tiene_clave ? '· 🔒' : ''}
                      </TableCell>
                      <TableCell className="text-xs">
                        {l?.active ? (
                          <span>
                            {l.bases.join(', ')} · lecturas {l.lectura === 'libre' ? 'sin preguntar' : 'con aprobación'}
                            {l.pruebas ? ' · variables en pruebas' : ''}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">sin usar</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button size="sm" variant="outline" onClick={() => setLinking(c)}>
                          <LinkIcon /> {l?.active ? 'Configurar' : 'Usar aquí'}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Editar ${c.name}`}
                          onClick={() => {
                            setEditing(c);
                            setFormOpen(true);
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        {l?.active ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Dejar de usar ${c.name}`}
                            onClick={() => void run(`/v1/bases/${c.name}/desvincular`, {}, { confirm: `¿Dejar de usar «${c.name}» en este proyecto?` })}
                          >
                            <XIcon />
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Eliminar ${c.name}`}
                            onClick={() =>
                              void run(
                                `/v1/bases/${c.name}/eliminar`,
                                {},
                                {
                                  confirm: {
                                    title: `¿Eliminar la conexión «${c.name}»?`,
                                    description: 'Se borra de esta máquina con su clave. La base de datos no se toca.',
                                    destructive: true,
                                    confirm: 'Eliminar',
                                  },
                                },
                              )
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <EmptyState icon={<DatabaseIcon />} title="No hay bases de datos registradas">
            Pulsa «Nueva conexión» y pega tu URL <Mono>jdbc:mysql://…</Mono> o tus variables: Forja completa el formulario.
          </EmptyState>
        )}
      </Section>

      {pending.length ? (
        <Section title={`Solicitudes por aprobar (${pending.length})`}>
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((r) => (
              <RequestCard key={r.req_id} r={r} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Tablas creadas por Forja" description="Las únicas que un agente puede modificar o borrar (siempre con tu aprobación). Las demás tablas de tus bases no se tocan.">
        {d.tablas_creadas.length ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tabla</TableHead>
                  <TableHead>Conexión · base</TableHead>
                  <TableHead>Creada por</TableHead>
                  <TableHead>Cuándo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.tablas_creadas.map((t) => (
                  <TableRow key={`${t.conn}/${t.base}/${t.name}`}>
                    <TableCell>
                      <Mono>{t.name}</Mono>
                    </TableCell>
                    <TableCell>
                      {t.conn} · <Mono>{t.base}</Mono>
                    </TableCell>
                    <TableCell className="text-xs">{t.created_by}</TableCell>
                    <TableCell className="text-xs">{fechaHora(t.created_at)}</TableCell>
                    <TableCell>{t.dropped_at ? <StatusBadge tone="muted">eliminada</StatusBadge> : <StatusBadge tone="ok">activa</StatusBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">Todavía ninguna.</p>
        )}
      </Section>

      {history.length ? (
        <Section title="Historial de consultas y cambios">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Qué</TableHead>
                  <TableHead>Quién</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden lg:table-cell">Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((r) => (
                  <TableRow key={r.req_id}>
                    <TableCell className="max-w-96">
                      <span className="text-xs text-muted-foreground">{KIND[r.kind]} · </span>
                      <Mono className="block truncate">{r.sql}</Mono>
                    </TableCell>
                    <TableCell className="text-xs">{r.origin}</TableCell>
                    <TableCell>
                      <StatusBadge tone={STATE_TONE[r.state]}>{r.state}</StatusBadge>
                    </TableCell>
                    <TableCell className="hidden max-w-72 truncate text-xs text-muted-foreground lg:table-cell">
                      {r.detail ?? (r.filas !== null ? `${r.filas} fila(s)` : r.resultado?.affected !== null && r.resultado?.affected !== undefined ? `${r.resultado.affected} afectada(s)` : '')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      ) : null}

      {d.solicitudes.some((s) => s.state === 'bloqueada') ? (
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>Forja bloqueó cambios sobre tablas que ya existían</AlertTitle>
          <AlertDescription>Aparecen en el historial como «bloqueada». No llegaron a la base de datos.</AlertDescription>
        </Alert>
      ) : null}

      <ConnectionDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <LinkDialog conn={linking} link={linking ? linkOf(linking.name) : undefined} onOpenChange={(v) => !v && setLinking(null)} />
    </div>
  );
}
