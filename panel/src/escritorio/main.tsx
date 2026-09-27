import '../index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/toaster';
import { useTheme } from '@/hooks/use-theme';
import { Asistente } from './asistente';

function Root() {
  useTheme();
  return (
    <>
      <Asistente />
      <Toaster />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
