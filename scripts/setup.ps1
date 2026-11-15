<#
.SYNOPSIS
  One-step developer setup for SOPHIE on Windows 10/11.

.DESCRIPTION
  Installs whatever is missing (Node.js LTS, Rust, the Visual Studio C++ Build Tools with
  the Windows SDK) through winget, installs the npm packages, and with -Build produces the
  installer in src-tauri\target\release\bundle\nsis.

  Tools that are already installed are left alone. Run it from the repository root:

    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Build

  End users do not need any of this: they run SOPHIE_x.y.z_x64-setup.exe from the
  GitHub Releases page.
#>
param(
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

function Has([string]$Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

function Install-Package([string]$Id, [string[]]$Extra = @()) {
    if (-not (Has 'winget')) {
        throw "winget is not available. Install 'App Installer' from the Microsoft Store, or install $Id by hand."
    }
    & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements @Extra
    # 0 = installed; -1978335189 = already installed / no newer version.
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget could not install $Id (exit $LASTEXITCODE)." }
    Refresh-Path
}

function Has-CppTools {
    $vswhere = @(
        'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe',
        'C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe'
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $vswhere) { return $false }
    [bool](& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}

Step 'Node.js'
if (Has 'node') { Write-Host "found $(node --version)" } else { Install-Package 'OpenJS.NodeJS.LTS' }

Step 'Rust'
Refresh-Path
if (Has 'cargo') {
    Write-Host "found $(cargo --version)"
} else {
    Install-Package 'Rustlang.Rustup'
    & rustup default stable
}

Step 'Visual Studio C++ Build Tools + Windows SDK'
if (Has-CppTools) {
    Write-Host 'found'
} else {
    Write-Host 'Installing (several GB; this takes a while)...'
    Install-Package 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
    if (-not (Has-CppTools)) { throw 'The C++ Build Tools did not install. Install the "Desktop development with C++" workload by hand.' }
}

Step 'npm packages'
& npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

if ($Build) {
    Step 'Building the installer'
    & npm run app:build
    if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }
    $setup = Get-ChildItem 'src-tauri\target\release\bundle\nsis\*-setup.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
    Write-Host "`nInstaller: $($setup.FullName)" -ForegroundColor Green
} else {
    Write-Host "`nReady. Run 'npm run app:dev' to start SOPHIE, or rerun with -Build for the installer." -ForegroundColor Green
}
