<#
  Builds the single executable: dist\PDFStreamEditor.exe

  tools\launcher\Launcher.cs is compiled into that exe with the app, the Electron
  runtime and qpdf embedded as a payload.zip resource and the app icon attached. Running
  it unpacks the payload into %LOCALAPPDATA%\PDFStreamEditor (only when the stamped copy
  is missing or from an older build), starts the app and exits. Arguments are passed on,
  so  PDFStreamEditor.exe document.pdf  opens that file.

  Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 [-KeepStage]
#>
[CmdletBinding()]
param(
  [string]$Name = 'PDFStreamEditor',
  [string]$InstallDir = 'PDFStreamEditor',
  [string]$OutDir = 'dist',
  [ValidateSet('Optimal', 'Fastest', 'NoCompression')]
  [string]$Compression = 'Optimal',
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$outDir = Join-Path $root $OutDir
$stage = Join-Path $outDir 'stage'
$zipPath = Join-Path $outDir 'payload.zip'
$exePath = Join-Path $outDir "$Name.exe"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "build failed: $msg" -ForegroundColor Red; exit 1 }

$sources = @()
foreach ($from in 'app', 'runtime', 'tools\qpdf') {
  if (-not (Test-Path -LiteralPath (Join-Path $root $from))) { Fail "missing input folder: $from" }
  $sources += $from
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'runtime\electron.exe'))) { Fail 'missing runtime\electron.exe' }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Start from a clean stage. Guard the recursive delete to this build's own folder.
$stageFull = [IO.Path]::GetFullPath($stage)
if (-not $stageFull.StartsWith([IO.Path]::GetFullPath($outDir) + [IO.Path]::DirectorySeparatorChar)) {
  Fail "refusing to clean outside the output folder: $stageFull"
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Step 'staging app, runtime and qpdf'
foreach ($from in $sources) {
  $to = Join-Path $stage $from
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $from) -Destination $to -Recurse -Force
}

Step "compressing the payload ($Compression)"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$level = switch ($Compression) {
  'Fastest' { [IO.Compression.CompressionLevel]::Fastest }
  'NoCompression' { [IO.Compression.CompressionLevel]::NoCompression }
  default { [IO.Compression.CompressionLevel]::Optimal }
}
$sw = [Diagnostics.Stopwatch]::StartNew()
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, $level, $false)
$sw.Stop()
Write-Host ("     {0:N1} MB in {1:N0}s" -f ((Get-Item -LiteralPath $zipPath).Length / 1MB), $sw.Elapsed.TotalSeconds)

Step 'compiling the single-file executable'
$csc = @(
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { Fail 'no C# compiler found (looked for the .NET Framework csc.exe and Visual Studio Roslyn)' }

$launcherSource = Join-Path $root 'tools\launcher\Launcher.cs'
if (-not (Test-Path -LiteralPath $launcherSource)) { Fail 'missing tools\launcher\Launcher.cs' }
$generatedSource = Join-Path $outDir 'launcher.generated.cs'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$launcherText = (Get-Content -LiteralPath $launcherSource -Raw).Replace('__STAMP__', $stamp).Replace('__APPFOLDER__', $InstallDir)
[IO.File]::WriteAllText($generatedSource, $launcherText, [Text.Encoding]::UTF8)

$iconPath = Join-Path $root 'app\icon.ico'
$cscArgs = @(
  '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll'
)
if (Test-Path -LiteralPath $iconPath) { $cscArgs += "/win32icon:$iconPath" }
$cscArgs += "/out:$exePath", "/resource:$zipPath,payload.zip", $generatedSource
if (Test-Path -LiteralPath $exePath) { Remove-Item -LiteralPath $exePath -Force }
& $csc $cscArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exePath)) { Fail 'the executable failed to compile' }

if (-not $KeepStage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
  Remove-Item -LiteralPath $zipPath -Force
  Remove-Item -LiteralPath $generatedSource -Force
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $exePath).Length / 1MB, 1)
Write-Host ''
Write-Host "built $exePath ($sizeMb MB)" -ForegroundColor Green
Write-Host "first run unpacks to %LOCALAPPDATA%\$InstallDir; delete that folder to uninstall" -ForegroundColor DarkGray
