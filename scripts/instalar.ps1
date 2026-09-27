# Instalador de un solo comando para Windows (usa WSL2 por debajo: Forja no corre
# nativo en Windows todavia, ver docs/decisiones/ADR-011-aislamiento-windows.md).
#
#   irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.ps1 | iex
#
# Que hace:
#   1. Activa WSL2 e instala Ubuntu si hace falta (puede pedir un reinicio la
#      primera vez que WSL se activa en la maquina) y le crea tu usuario de Linux.
#   2. Dentro de esa Ubuntu, corre scripts/instalar.sh: primero la parte de root con
#      "wsl -u root" (Windows no pide contrasena para eso) y despues la de tu usuario
#      (clona, compila e instala Forja). Asi nunca te pide la contrasena de sudo.
#   3. Deja un forja.cmd en tu PATH de Windows que reenvia cada comando a esa
#      Ubuntu, para que puedas escribir "forja ..." directo en PowerShell.
#
# Ejecutar como administrador solo hace falta si WSL2 no esta activado todavia.
# Sin caracteres fuera de ASCII a proposito: PowerShell 5.1 (el que trae Windows
# por defecto) puede leer un .ps1 en UTF-8 con la codificacion equivocada si no
# tiene BOM, y eso corrompe el parser entero, no solo el texto de un mensaje.

$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu'

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'wsl')) {
  throw "No se encontro wsl.exe. Este script necesita Windows 10 2004+ o Windows 11. Instala WSL manualmente: https://aka.ms/wslinstall"
}

function ConvertTo-WslPath($winPath) {
  # No usamos "wsl -- wslpath ...": WSL tiene un bug conocido donde las barras
  # invertidas de un argumento pasado despues de "--" se comen solas (una ruta como
  # C:\Users\x llega como CUsersx). Traducimos nosotros mismos: mismo mapeo que usa
  # WSL2 por defecto (drvfs en /mnt/<letra minuscula>).
  $full = (Resolve-Path $winPath).Path
  if ($full -notmatch '^([A-Za-z]):\\(.*)$') { throw "no se pudo traducir la ruta '$full' a una ruta de WSL (formato inesperado)." }
  $drive = $Matches[1].ToLower()
  $rest = $Matches[2] -replace '\\', '/'
  return "/mnt/$drive/$rest"
}

# Corre un script de bash como root dentro de la distro. Va por archivo y no por "bash -c":
# WSL se come barras invertidas y comillas anidadas al reenviar argumentos.
function Invoke-RootScript($text) {
  $file = Join-Path $env:TEMP 'forja-root.sh'
  [System.IO.File]::WriteAllText($file, (($text -replace "`r`n", "`n") -replace "`r", "`n"))
  wsl -d $distro -u root -- bash (ConvertTo-WslPath $file)
  if ($LASTEXITCODE -ne 0) { throw "fallo un paso de administrador dentro de $distro (codigo $LASTEXITCODE)." }
}

Write-Host "- revisando distros de WSL instaladas..."
$distrosRaw = (wsl -l -q 2>$null) -join "`n"
$distros = $distrosRaw -split "`r?`n" | Where-Object { $_ -and $_.Trim() -ne '' }
# `wsl -l -q` a veces devuelve UTF-16 con caracteres nulos intercalados.
$distros = $distros | ForEach-Object { ($_ -replace "`0", '').Trim() }

# Estas dos pueden fallar a proposito (la distro aun no arranca, no hay usuario): con
# 'Stop', PowerShell 5.1 convierte el stderr de wsl en una excepcion aunque vaya a $null.
function Test-RootAccess {
  $ErrorActionPreference = 'Continue'
  wsl -d $distro -u root -- true 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}
function Get-FirstLinuxUser {
  $ErrorActionPreference = 'Continue'
  return (wsl -d $distro -u root -- getent passwd 1000 2>$null)
}

if ($distros -notcontains $distro) {
  Write-Host "- $distro no esta instalada. Instalando (esto puede tardar varios minutos)..."
  # --no-launch: sin la ventana que pide crear usuario y contrasena; el usuario lo creamos
  # nosotros mas abajo.
  wsl --install -d $distro --no-launch
  if (-not (Test-RootAccess)) {
    Write-Host ""
    Write-Host "OK: se lanzo la instalacion de $distro."
    Write-Host "  Si esta es la PRIMERA vez que usas WSL en esta maquina, Windows pide reiniciar."
    Write-Host "  Reinicia y vuelve a correr este mismo comando: sigue solo desde ahi."
    exit 0
  }
}

# Tu usuario de Linux. Si la distro nunca se abrio no tiene ninguno (el primero que se crea
# es el uid 1000): se crea uno con tu nombre de Windows, sin contrasena, y queda como el
# usuario por defecto. No necesita sudo: lo que requiere root se hace con "wsl -u root",
# que tu sesion de Windows ya puede usar sin contrasena.
if (-not (Test-RootAccess)) {
  throw "no se pudo entrar a $distro. Abre la app '$distro' desde el menu inicio una vez y vuelve a correr este script."
}
if (-not (Get-FirstLinuxUser)) {
  $linuxUser = ($env:USERNAME.ToLower() -replace '[^a-z0-9_-]', '')
  if ($linuxUser -notmatch '^[a-z_]') { $linuxUser = "u$linuxUser" }
  if ($linuxUser.Length -gt 32) { $linuxUser = $linuxUser.Substring(0, 32) }
  if ($linuxUser -in @('u', 'root')) { $linuxUser = 'forja' }
  Write-Host "- creando tu usuario de Linux '$linuxUser' (sin contrasena que recordar)..."
  $setup = @"
set -e
id -u $linuxUser >/dev/null 2>&1 || useradd -m -u 1000 -s /bin/bash $linuxUser
touch /etc/wsl.conf
if grep -q '^\[user\]' /etc/wsl.conf; then
  sed -i '/^\[user\]/,/^\[/{/^default=/d}' /etc/wsl.conf
  sed -i 's/^\[user\]`$/[user]\ndefault=$linuxUser/' /etc/wsl.conf
else
  printf '\n[user]\ndefault=%s\n' $linuxUser >>/etc/wsl.conf
fi
"@
  Invoke-RootScript $setup
  # El usuario por defecto se lee al arrancar la distro.
  wsl --terminate $distro | Out-Null
}

$whoami = (wsl -d $distro -- whoami 2>$null)
if (-not $whoami -or $whoami -eq 'root') {
  throw "$distro no tiene un usuario normal por defecto. Abre la app '$distro' desde el menu inicio, crea tu usuario y vuelve a correr este script."
}

Write-Host "- instalando Forja dentro de $distro (clona, compila e instala)..."
# Si este script corre desde una copia ya clonada (el caso normal: git clone en Windows y
# .\scripts\instalar.ps1 desde ahi), reusamos esa copia como fuente en vez de bajarla de
# internet: mas rapido y no depende de que el repo sea publico. Si corrio via "irm | iex"
# no hay copia local, y ahi si hace falta bajarla de GitHub.

$repoRoot = $null
if ($PSScriptRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $candidate '.git')) { $repoRoot = $candidate }
}

if ($repoRoot) {
  $wslRepoPath = ConvertTo-WslPath $repoRoot
  Write-Host "  usando la copia local ya clonada ($repoRoot) en vez de bajarla de internet"
  # Si Git en Windows convirtio instalar.sh a CRLF al clonar (core.autocrlf=true, comun),
  # bash lo rompe con errores confusos ("set: pipefail: invalid option name": el \r queda
  # pegado al final de la opcion). No dependemos de que el checkout del usuario este bien:
  # se normaliza a LF en una copia aparte antes de correrlo, cada vez.
  $localScript = Join-Path $repoRoot 'scripts\instalar.sh'
  $normalizedScript = Join-Path $env:TEMP 'forja-instalar-normalizado.sh'
  $scriptText = (Get-Content -Raw -Path $localScript) -replace "`r`n", "`n" -replace "`r", "`n"
  [System.IO.File]::WriteAllText($normalizedScript, $scriptText)
  $wslNormalizedScript = ConvertTo-WslPath $normalizedScript
  # Primero lo que necesita root, sin contrasena (ver arriba); despues lo de tu usuario.
  wsl -d $distro -u root -- bash $wslNormalizedScript --sistema
  if ($LASTEXITCODE -ne 0) { throw "el instalador (parte de sistema) fallo (codigo $LASTEXITCODE); revisa el mensaje de arriba." }
  # Nada de un string con comillas incrustadas para "bash -lc": WSL vuelve a comerse cosas
  # al reconstruir la linea de comandos con comillas anidadas (mismo tipo de bug que con
  # las barras invertidas). Argumentos sueltos, sin comillas que pasar por el medio.
  # bash -l (no -c): sigue actuando como shell de login (carga el PATH que nvm agrego a
  # los dotfiles) pero corriendo el script como archivo, sin envolverlo en un string.
  wsl -d $distro -- env "FORJA_SOURCE=$wslRepoPath" bash -l $wslNormalizedScript
} else {
  # "curl ... | bash" no basta: si curl falla (p. ej. 404), bash recibe stdin vacio y sale
  # con exito igual, tapando el error. Bajar a un archivo primero y correrlo aparte.
  # Archivos distintos para root y para tu usuario: en /tmp uno no puede pisar el del otro.
  wsl -d $distro -u root -- bash -c "curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh -o /tmp/forja-instalar-root.sh && bash /tmp/forja-instalar-root.sh --sistema"
  if ($LASTEXITCODE -ne 0) { throw "el instalador (parte de sistema) fallo (codigo $LASTEXITCODE); revisa el mensaje de arriba." }
  wsl -d $distro -- bash -lc "curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh -o /tmp/forja-instalar.sh && bash /tmp/forja-instalar.sh"
}
if ($LASTEXITCODE -ne 0) { throw "el instalador dentro de $distro fallo (codigo $LASTEXITCODE); revisa el mensaje de arriba." }

Write-Host "- dejando 'forja' disponible en PowerShell..."
$binDir = Join-Path $env:LOCALAPPDATA 'Forja\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir 'forja.cmd'
$shimContent = "@echo off`r`nwsl -d $distro -- forja %*`r`n"
Set-Content -Path $shim -Value $shimContent -Encoding ASCII -NoNewline

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
}
# Tambien en esta misma ventana, para no tener que abrir otra PowerShell.
if ($env:Path -notlike "*$binDir*") { $env:Path = "$env:Path;$binDir" }

# Acceso directo en el escritorio: doble clic y Forja se abre en el navegador.
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $desktop 'Forja.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wsl.exe'
  $lnk.Arguments = "-d $distro -- forja"
  $lnk.WorkingDirectory = $env:USERPROFILE
  $lnk.Description = 'Abrir Forja en el navegador'
  $lnk.Save()
  Write-Host "- acceso directo 'Forja' creado en tu escritorio"
} catch {
  Write-Host "  (no se pudo crear el acceso directo: $($_.Exception.Message))"
}

Write-Host ""
Write-Host "OK: Forja esta instalado. Abriendolo en tu navegador..."
Write-Host "    Ahi eliges tu proyecto y le cuentas a Forja que quieres hacer."
Write-Host "    Deja esta ventana abierta mientras lo usas; Ctrl+C para cerrarlo."
Write-Host "    La proxima vez: doble clic en 'Forja' en tu escritorio (o escribe: forja)."
Write-Host ""
wsl -d $distro -- forja
