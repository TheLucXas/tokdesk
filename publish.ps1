# Genera dist\Tokdesk.exe (un solo archivo: lanzador + app) y el zip para compartir.
# Con -Release además crea la release vX.Y.Z en GitHub y sube el .exe (lo usa el actualizador).
#   .\publish.ps1                 -> solo compila
#   .\publish.ps1 -Release -Notes "Cambios..."
# Para -Release hace falta gh con sesión iniciada (gh auth login).
param([switch]$Release, [string]$Notes = "")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$proj = Join-Path $root "Tokdesk\Tokdesk.csproj"
$dist = Join-Path $root "dist"

[xml]$x = Get-Content $proj
$version = ($x.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1).Version
Write-Host "Versión $version"

# 1) La app, sin .NET incluido (lo instala el lanzador si falta)
dotnet publish $proj -c Release -p:PublishSingleFile=true -o (Join-Path $dist "app") -v q -nologo
if ($LASTEXITCODE -ne 0) { throw "Falló la compilación de la app" }

# 2) El lanzador (.NET Framework 4.8, viene con Windows) con la app incrustada
$launcher = Join-Path $root "Launcher\Launcher.csproj"
dotnet build $launcher -c Release "-p:Version=$version" -o (Join-Path $dist "launcher") -v q -nologo
if ($LASTEXITCODE -ne 0) { throw "Falló la compilación del lanzador" }
# Si el notificador en segundo plano está usando el .exe, se aparta (renombrar un .exe en uso sí se puede)
$exe = Join-Path $dist "Tokdesk.exe"
if (Test-Path $exe) {
  Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
  try { Remove-Item $exe -Force -ErrorAction Stop } catch { Rename-Item $exe "Tokdesk.exe.old" }
}
Copy-Item (Join-Path $dist "launcher\Tokdesk.exe") $exe -Force
$zip = Join-Path $dist "Tokdesk-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }
# El .exe recién copiado puede estar un momento en uso (antivirus): se reintenta
for ($i = 0; $i -lt 10 -and -not (Test-Path $zip); $i++) {
  try { Compress-Archive -Path (Join-Path $dist "Tokdesk.exe") -DestinationPath $zip -ErrorAction Stop } catch { Start-Sleep -Milliseconds 800 }
}
Write-Host ("Listo: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))

if (-not $Release) { return }

# Publica con gh (sesión de GitHub iniciada con "gh auth login")
$cfg = Get-Content (Join-Path $root "Tokdesk\update.json") -Raw | ConvertFrom-Json
# Las notas van por archivo: PowerShell 5.1 parte los argumentos con comillas al pasarlos a gh
$notesFile = Join-Path $env:TEMP "tokdesk-notes.md"
[IO.File]::WriteAllText($notesFile, $(if ($Notes) { $Notes } else { "Tokdesk $version" }), (New-Object Text.UTF8Encoding $false))
gh release create "v$version" (Join-Path $dist "Tokdesk.exe") --repo $cfg.repo --title "Tokdesk $version" --notes-file $notesFile
if ($LASTEXITCODE -ne 0) { throw "No se pudo publicar la release" }
Write-Host "Release v$version publicada en $($cfg.repo)"