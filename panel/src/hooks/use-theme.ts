import { useEffect, useState } from 'react';

export type Theme = 'claro' | 'oscuro' | 'sistema';
const KEY = 'forja-tema';

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'claro' || v === 'oscuro' ? v : 'sistema';
  } catch {
    return 'sistema';
  }
}

/** Light/dark like shadcn: a `dark` class on <html>, following the system unless chosen. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'oscuro' || (theme === 'sistema' && media.matches));
    apply();
    media.addEventListener('change', apply);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Private mode: the choice lasts until the tab closes.
    }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}
