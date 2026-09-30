import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * A screen that fails to render shows what happened instead of leaving the whole panel
 * blank; the menu keeps working and moving to another screen clears it (`resetKey`).
 */
export class ScreenBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  override state: { error: Error | null; key: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Forja: una pantalla falló al dibujarse', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert variant="destructive" className="max-w-2xl">
        <TriangleAlertIcon />
        <AlertTitle>Esta pantalla tuvo un error</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>El resto del panel sigue funcionando. Si se repite, avísanos con este mensaje:</p>
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap text-foreground">{this.state.error.message}</pre>
          <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
            <RotateCcwIcon /> Reintentar
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
}
