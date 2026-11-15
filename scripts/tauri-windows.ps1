param(
    [ValidateSet('dev', 'build', 'check', 'test')]
    [string]$Action = 'dev'
)

$vswhereCandidates = @(
    'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe',
    'C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe'
)
$vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $vswhere) {
    throw 'Visual Studio C++ Build Tools are required. Install the Desktop development with C++ workload.'
}

$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) {
    throw 'Visual Studio C++ tools were not found. Install the Desktop development with C++ workload.'
}

$devCommand = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $devCommand)) {
    throw "Visual Studio developer environment was not found at $devCommand"
}

$taskCommand = if ($Action -eq 'check') { 'cargo check --manifest-path src-tauri\Cargo.toml' }
    elseif ($Action -eq 'test') { 'cargo test --manifest-path src-tauri\Cargo.toml' }
    else { 'npm run tauri ' + $Action }
$command = 'call "' + $devCommand + '" -arch=x64 -host_arch=x64 >nul && ' + $taskCommand
& $env:ComSpec /d /s /c $command
exit $LASTEXITCODE
