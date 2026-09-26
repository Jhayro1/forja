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
wsl -d $distro -- bash -lc "curl -fsSL https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/instalar.sh | bash"
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
  Write-Host "  agregado $binDir a tu PATH de usuario (abre una terminal nueva para que aplique)"
}

Write-Host ""
Write-Host "OK: Listo. Abre una PowerShell NUEVA (para que tome el PATH actualizado) y corre:"
Write-Host "    forja doctor"
Write-Host ""
Write-Host "Nota: por debajo sigue corriendo dentro de WSL2/$distro, no nativo en Windows"
Write-Host "(el aislamiento nativo de Windows todavia es un prototipo, ver ADR-011)."
Write-Host "Rutas de Windows tipo C:\... dentro de argumentos de forja: usa la ruta estilo"
Write-Host "Linux (/mnt/c/...) o trabaja parado en tu proyecto con 'forja importar .'"
