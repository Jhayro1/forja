import { ExternalLinkIcon, GitPullRequestIcon, UploadCloudIcon } from 'lucide-react';
import { useApp } from '@/app/context';
import { Mono, StatusBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { fechaHora, safeUrl } from '@/lib/format';
import type { Entrega } from '@/lib/types';

/**
 * The sprint's delivery on GitHub: push its branch and open the PR. Forja never merges and
 * never touches the main branch; merging is always the owner's decision on GitHub.
 */
export function DeliveryCard() {
  const { go, has } = useApp();
  const { run, busy } = useAction();
  const q = useApiQuery<{ entrega: Entrega }>(has('trabajo') ? '/v1/entrega' : null);
  const e = q.data?.entrega;
  if (!e?.lista || !e.rama) return null;
  const pr = e.publicada?.pr ?? null;
  const prUrl = safeUrl(pr?.url);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitPullRequestIcon className="size-4" /> Entrega en GitHub
        </CardTitle>
        <CardDescription>
          Rama <Mono>{e.rama}</Mono>. Forja sube esta rama y abre el PR; unirlo a la rama principal lo decides tú en GitHub.
        </CardDescription>
        <CardAction>{e.publicada ? <StatusBadge tone="ok">{pr ? `PR #${pr.numero}` : 'rama subida'}</StatusBadge> : <StatusBadge tone="muted">sin publicar</StatusBadge>}</CardAction>
      </CardHeader>
      {e.publicada ? (
        <CardContent className="text-sm text-muted-foreground">
          Publicada el {fechaHora(e.publicada.fecha)} en <Mono>{e.publicada.repositorio}</Mono> (commit <Mono>{e.publicada.commit.slice(0, 8)}</Mono>).
        </CardContent>
      ) : null}
      <CardFooter className="flex-wrap gap-2">
        {e.github?.configurado ? (
          <Button
            disabled={busy !== null}
            onClick={() =>
              void run(
                '/v1/entrega/publicar',
                {},
                { confirm: { title: '¿Subir la rama y abrir el PR?', description: `Se sube ${e.rama} a GitHub y se abre un PR contra la rama principal. Forja no lo une.`, confirm: 'Publicar' } },
              )
            }
          >
            <UploadCloudIcon /> {e.publicada ? 'Subir de nuevo' : 'Subir a GitHub y abrir PR'}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => go('configuracion')}>
            Configurar el token de GitHub
          </Button>
        )}
        {prUrl ? (
          <Button asChild variant="outline">
            <a href={prUrl} target="_blank" rel="noopener noreferrer">
              Ver el PR <ExternalLinkIcon />
            </a>
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
