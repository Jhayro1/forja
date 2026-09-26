import { describe, expect, it } from 'vitest';
import { fromUserPath, isWsl, toWindowsPath } from '../../src/registry/paths.js';

describe('rutas pegadas por el usuario', () => {
  it('traduce rutas de Windows a /mnt/<letra>', () => {
    expect(fromUserPath('C:\\Users\\Jhayro\\Desktop\\WINKSTEC-ERP\\winkstec-erp')).toBe('/mnt/c/Users/Jhayro/Desktop/WINKSTEC-ERP/winkstec-erp');
    expect(fromUserPath('d:/proyectos/app/')).toBe('/mnt/d/proyectos/app');
    expect(fromUserPath('"C:\\Users\\Ana Maria\\app"')).toBe('/mnt/c/Users/Ana Maria/app');
    expect(fromUserPath('C:\\')).toBe('/mnt/c');
  });

  it('traduce rutas de red de WSL y deja las de Linux como están', () => {
    expect(fromUserPath('\\\\wsl.localhost\\Ubuntu\\home\\jhayro\\app')).toBe('/home/jhayro/app');
    expect(fromUserPath('\\\\wsl$\\Ubuntu\\home\\jhayro')).toBe('/home/jhayro');
    expect(fromUserPath('  /home/jhayro/app  ')).toBe('/home/jhayro/app');
    expect(fromUserPath('~/app')).toBe('~/app');
  });

  it('muestra la versión de Windows de una ruta /mnt', () => {
    expect(toWindowsPath('/mnt/c/Users/Jhayro/app')).toBe('C:\\Users\\Jhayro\\app');
    expect(toWindowsPath('/mnt/c')).toBe('C:\\');
    expect(toWindowsPath('/home/jhayro')).toBeNull();
  });

  it('detecta WSL por /proc/version', () => {
    if (process.platform !== 'linux') return;
    expect(isWsl(() => 'Linux version 5.15.167.4-microsoft-standard-WSL2')).toBe(true);
    expect(isWsl(() => 'Linux version 6.8.0-generic')).toBe(false);
  });
});
