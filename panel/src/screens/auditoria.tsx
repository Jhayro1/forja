import { EmptyState, Mono, PageHeader } from '@/components/common';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApiQuery } from '@/hooks/use-api';
import type { Auditoria as Row } from '@/lib/types';

export default function Auditoria() {
  const q = useApiQuery<{ auditoria: Row[] }>('/v1/auditoria');
  const rows = q.data?.auditoria ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title="Auditoría" description="Conexiones, servidores MCP y acciones externas de este proyecto, en orden." />
      {rows.length ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo (UTC)</TableHead>
                <TableHead>Qué</TableHead>
                <TableHead>Sobre</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log.
                <TableRow key={i}>
                  <TableCell>
                    <Mono>{r.cuando}</Mono>
                  </TableCell>
                  <TableCell>{r.que}</TableCell>
                  <TableCell>
                    <Mono>{r.sobre}</Mono>
                  </TableCell>
                  <TableCell className="max-w-96 whitespace-normal">{r.detalle}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState title="Sin registros" />
      )}
    </div>
  );
}
