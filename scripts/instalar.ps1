# Instalador de un solo comando para Windows (usa WSL2 por debajo: Forja no corre
# nativo en Windows todavia, ver docs/decisiones/ADR-011-aislamiento-windows.md).
#
#   irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.ps1 | iex
#
# Que hace:
#   1. Activa WSL2 e instala Ubuntu si hace falta (puede pedir un reinicio la
#      primera vez que WSL se activa en la maquina).
#   2. Dentro de esa Ubuntu, corre scripts/instalar.sh (clona, compila e instala
#      Forja global).
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

Write-Host "- revisando distros de WSL instaladas..."
$distrosRaw = (wsl -l -q 2>$null) -join "`n"
$distros = $distrosRaw -split "`r?`n" | Where-Object { $_ -and $_.Trim() -ne '' }
# `wsl -l -q` a veces devuelve UTF-16 con caracteres nulos intercalados.
$distros = $distros | ForEach-Object { ($_ -replace "`0", '').Trim() }

if ($distros -notcontains $distro) {
  Write-Host "- $distro no esta instalada. Instalando (esto puede tardar varios minutos)..."
  wsl --install -d $distro
  Write-Host ""
  Write-Host "OK: se lanzo la instalacion de $distro."
  Write-Host "  Si esta es la PRIMERA vez que usas WSL en esta maquina, Windows puede pedirte"
  Write-Host "  reiniciar. Reinicia, abre la app '$distro' UNA VEZ para crear tu usuario y"
  Write-Host "  contrasena de Linux, y despues vuelve a correr este mismo comando."
  Write-Host "  Si NO pide reiniciar, solo espera a que termine y este script sigue solo."
  exit 0
}

Write-Host "- $distro ya esta instalada, revisando que tenga un usuario creado..."
$whoami = (wsl -d $distro -- whoami 2>$null)
if (-not $whoami) {
  throw "$distro esta instalada pero no completo su primer arranque. Abre la app '$distro' desde el menu inicio, crea tu usuario y contrasena de Linux, y vuelve a correr este script."
}

Write-Host "- instalando Forja dentro de $distro (clona, compila e instala)..."
# Si este script corre desde una copia ya clonada (el caso normal: git clone en Windows y
# .\scripts\instalar.ps1 desde ahi), reusamos esa copia como fuente en vez de bajarla de
# internet: mas rapido y no depende de que el repo sea publico. Si corrio via "irm | iex"
# no hay copia local, y ahi si hace falta bajarla de GitHub.
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
  # Nada de un string con comillas incrustadas para "bash -lc": WSL vuelve a comerse cosas
  # al reconstruir la linea de comandos con comillas anidadas (mismo tipo de bug que con
  # las barras invertidas). Argumentos sueltos, sin comillas que pasar por el medio.
  # bash -l (no -c): sigue actuando como shell de login (carga el PATH que nvm agrego a
  # los dotfiles) pero corriendo el script como archivo, sin envolverlo en un string.
  wsl -d $distro -- env "FORJA_SOURCE=$wslRepoPath" bash -l $wslNormalizedScript
} else {
  # "curl ... | bash" no basta: si curl falla (p. ej. 404), bash recibe stdin vacio y sale
  # con exito igual, tapando el error. Bajar a un archivo primero y correrlo aparte.
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
