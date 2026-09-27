import { EmptyState, Mono, PageHeader, Section } from '@/components/common';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApiQuery } from '@/hooks/use-api';
import type { Conexiones as Data } from '@/lib/types';

export default function Conexiones() {
  const q = useApiQuery<{ conexiones: Data }>('/v1/conexiones');
  const d = q.data?.conexiones;
  if (!d) return <PageHeader title="Conexiones" description="Cargando…" />;
  const link = (name: string, version: number) => {
    const l = d.vinculos.find((x) => x.connection === name && x.active);
    if (!l) return 'sin vincular';
    return l.version !== version ? 'cambió: vuelve a vincular' : l.operations.join(', ');
  };
  return (
    <div className="space-y-10">
      <PageHeader title="Conexiones" description="Los secretos viven en la bóveda de esta máquina; aquí sólo aparecen sus nombres. Crear y vincular se hace en la terminal." />
      <Section title="Servicios">
        {d.conexiones.length ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Conexión</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Secreto</TableHead>
                  <TableHead>Idempotente</TableHead>
                  <TableHead>En este proyecto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.conexiones.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell>
                      <span className="font-medium">{c.name}</span> v{c.version}
                    </TableCell>
                    <TableCell>
                      <Mono>{c.base_url}</Mono>
                    </TableCell>
                    <TableCell>
                      <Mono>{c.secret ?? '—'}</Mono>
                    </TableCell>
                    <TableCell>{c.idempotent ? 'sí' : 'no'}</TableCell>
                    <TableCell>{link(c.name, c.version)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <EmptyState title="No hay conexiones">
            En la terminal: <Mono>forja conexion nueva &lt;nombre&gt; --url https://…</Mono>
          </EmptyState>
        )}
      </Section>
      <Section title="Servidores MCP">
        {d.mcp.length ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Servidor</TableHead>
                  <TableHead>Versión</TableHead>
                  <TableHead>Herramientas autorizadas</TableHead>
                  <TableHead>En este proyecto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.mcp.map((m) => (
                  <TableRow key={m.name}>
                    <TableCell>
                      <p className="font-medium">{m.name}</p>
                      <Mono className="text-muted-foreground">{m.command}</Mono>
                    </TableCell>
                    <TableCell>{m.declared_version}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{m.tools.join(', ')}</TableCell>
                    <TableCell>{link(`mcp:${m.name}`, m.version)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <EmptyState title="No hay servidores MCP registrados" />
        )}
      </Section>
    </div>
  );
}
