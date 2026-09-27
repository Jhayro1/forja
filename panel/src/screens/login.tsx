import { KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { Field, Mono } from '@/components/common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function Login({ message }: { message?: string | undefined }) {
  const [code, setCode] = useState('');
  const enter = () => {
    location.hash = `codigo=${encodeURIComponent(code.trim())}`;
    location.reload();
  };
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted">
            <KeyRoundIcon className="size-5" />
          </div>
          <CardTitle className="text-xl">Entrar al panel</CardTitle>
          <CardDescription>
            Vuelve a abrir Forja (el acceso directo o <Mono>forja</Mono> en tu terminal): abre el panel con una sesión nueva. También puedes pegar aquí el código del enlace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              enter();
            }}
          >
            {message ? (
              <Alert variant="destructive">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            <Field label="Código de acceso" htmlFor="codigo">
              <Input id="codigo" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button type="submit" disabled={!code.trim()}>
              Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
