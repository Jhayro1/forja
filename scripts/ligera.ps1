# Forja Ligera: instalador de un solo comando para Windows (ligera/PLAN.md F5).
#
#   irm https://raw.githubusercontent.com/Jhayro1/forja/main/scripts/ligera.ps1 | iex
#
# Sin WSL, sin Ubuntu, sin usuario de Linux y sin permisos de administrador:
#   1. Usa tu Node (22.13 o mas nuevo). Si no hay, baja Node portable (~30 MB) a
#      %LOCALAPPDATA%\Forja, verificado con su SHA-256 oficial.
#   2. Revisa Git (si falta, lo instala con winget; eso si puede pedir permiso).
#   3. Instala Forja Ligera ya compilada en %LOCALAPPDATA%\Forja (nada que compilar).
#   4. Deja el comando "forja" en tu PATH y un acceso "Forja" en el menu Inicio.
#   5. Detecta el Claude Code y el Codex que ya tienes y abre el panel.
#
# Desinstalar: borra la carpeta %LOCALAPPDATA%\Forja y el acceso "Forja" del menu
# Inicio. Tus proyectos y tus sesiones de Claude/Codex no se tocan.
#
# Sin caracteres fuera de ASCII a proposito: PowerShell 5.1 puede leer un .ps1 en UTF-8
# sin BOM con la codificacion equivocada y eso rompe el parser entero.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$prefix = Join-Path $env:LOCALAPPDATA 'Forja'
$paquete = if ($env:FORJA_PAQUETE) { $env:FORJA_PAQUETE } else { 'https://github.com/Jhayro1/forja/releases/latest/download/forja-ligera.tgz' }
$minNode = [version]'22.13.0'
$inicio = Get-Date

function Paso($texto) { Write-Host "- $texto" }

function Get-NodeVersion($exe) {
  try {
    $v = (& $exe -v 2>$null)
    if ($v -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  } catch { }
  return $null
}

New-Item -ItemType Directory -Force -Path $prefix | Out-Null

# 1. Node
$node = $null
$npm = $null
$propio = Join-Path $prefix 'node.exe'
$sistema = Get-Command node.exe -ErrorAction SilentlyContinue
if ($sistema -and (Get-NodeVersion $sistema.Source) -ge $minNode) {
  $node = $sistema.Source
  $npm = Join-Path (Split-Path $node) 'npm.cmd'
  if (-not (Test-Path $npm)) { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
  Paso "Node $(Get-NodeVersion $node) ya instalado"
} elseif ((Test-Path $propio) -and (Get-NodeVersion $propio) -ge $minNode) {
  $node = $propio
  $npm = Join-Path $prefix 'npm.cmd'
  Paso "Node $(Get-NodeVersion $node) (el de Forja)"
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  Paso "bajando Node portable ($arch) a $prefix..."
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $sumas = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $linea = $sumas | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $linea) { throw "no encontre Node para Windows $arch en $base" }
  $hash, $zipName = ($linea.Trim() -split '\s+')
  $zip = Join-Path $env:TEMP $zipName
  Invoke-WebRequest -UseBasicParsing "$base/$zipName" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { throw "la descarga de Node no coincide con su SHA-256 oficial; no se instala nada" }
  $tmp = Join-Path $env:TEMP "forja-node-$(Get-Random)"
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item -Path (Join-Path $dir.FullName '*') -Destination $prefix -Recurse -Force
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  $node = $propio
  $npm = Join-Path $prefix 'npm.cmd'
  Paso "Node $(Get-NodeVersion $node) listo"
}
if (-not $npm -or -not (Test-Path $npm)) { throw "no encontre npm junto a $node" }

# 2. Git
if (Get-Command git.exe -ErrorAction SilentlyContinue) {
  Paso "$(git --version)"
} elseif (Get-Command winget.exe -ErrorAction SilentlyContinue) {
  Paso 'Git no esta instalado: instalandolo con winget (puede pedir permiso)...'
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git se instalo pero no aparece todavia: cierra y abre PowerShell y vuelve a correr este comando' }
} else {
  throw 'Falta Git. Instalalo desde https://git-scm.com/download/win y vuelve a correr este comando.'
}

# 3. Forja Ligera (ya compilada)
Paso 'instalando Forja Ligera...'
$env:Path = "$(Split-Path $node);$env:Path"
& $npm install -g --prefix $prefix --no-audit --no-fund --no-update-notifier --loglevel=error $paquete
if ($LASTEXITCODE -ne 0) { throw "npm no pudo instalar $paquete (codigo $LASTEXITCODE)" }
$forja = Join-Path $prefix 'forja.cmd'
if (-not (Test-Path $forja)) { throw "la instalacion no dejo $forja" }

# 4. PATH y acceso directo
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $prefix) {
  [Environment]::SetEnvironmentVariable('Path', (@($prefix) + ($userPath -split ';' | Where-Object { $_ })) -join ';', 'User')
  Paso "comando 'forja' agregado a tu PATH (abre una PowerShell nueva para usarlo)"
}
$env:Path = "$prefix;$env:Path"
$menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Forja.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($menu)
$lnk.TargetPath = $forja
$lnk.Arguments = 'ui'
$lnk.WorkingDirectory = $env:USERPROFILE
$lnk.Description = 'Forja Ligera: abre el panel'
$lnk.Save()
Paso 'acceso "Forja" creado en el menu Inicio'

# 5. Tus agentes
$claude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$codex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
Write-Host ''
Write-Host "Claude Code: $(if ($claude) { 'encontrado' } else { 'no encontrado' }) | Codex: $(if ($codex) { 'encontrado' } else { 'no encontrado' })"
if (-not $claude -and -not $codex) {
  Write-Host 'Necesitas al menos uno. Desde el panel puedes instalarlos e iniciar sesion, o en PowerShell:'
  Write-Host '  npm install -g @anthropic-ai/claude-code   (y luego: claude)'
  Write-Host '  npm install -g @openai/codex               (y luego: codex login)'
}
$seg = [int]((Get-Date) - $inicio).TotalSeconds
Write-Host ''
Write-Host "Listo en $seg s. Forja Ligera esta en $prefix."
if ($env:FORJA_SIN_ABRIR -eq '1') {
  Write-Host 'Abre el panel con: menu Inicio > Forja, o "forja ui" en una PowerShell nueva.'
} else {
  Write-Host 'Abriendo el panel... (despues: menu Inicio > Forja, o "forja ui" en una PowerShell nueva)'
  Start-Process -FilePath $forja -ArgumentList 'ui' -WorkingDirectory $env:USERPROFILE
}
