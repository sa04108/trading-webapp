$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$templatePath = Join-Path $repo 'scripts\install-agent-windows.ps1'
$template = [IO.File]::ReadAllText($templatePath)
$marker = '#__AGENT_POWERSHELL_PAYLOAD__'
$root = Join-Path ([IO.Path]::GetTempPath()) ("quant-agent-installer-" + [guid]::NewGuid().ToString('N'))
$savedEnvironment = @{}
foreach ($key in @('ProgramFiles', 'LOCALAPPDATA', 'Path', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_TLS', 'DOCKER_CERT_PATH', 'QUANT_AGENT_SERVER_URL', 'QUANT_AGENT_TOKEN', 'QUANT_AGENT_INSTALLER', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432')) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

function Assert-Equal($Expected, $Actual, [string] $Message) {
  if ($Expected -cne $Actual) { throw "$Message. Expected '$Expected', got '$Actual'." }
}

function Find-CallIndex([string] $Pattern) {
  for ($i = 0; $i -lt $script:Calls.Count; $i++) {
    if ($script:Calls[$i] -match $Pattern) { return $i }
  }
  return -1
}

function docker {
  $parts = @($args | ForEach-Object { [string] $_ })
  $script:Calls += ,($parts -join ' ')
  if ($parts -contains 'run' -and ($parts -contains $script:Token -or $parts -contains 'https://agent.example')) {
    throw 'Secret values must be passed through inherited environment variables, not Docker arguments.'
  }
  $script:RunSawExpectedEnvironment = $script:RunSawExpectedEnvironment -or (
    $parts -contains 'run' -and
    $parts -contains '--env' -and
    $parts -contains 'QUANT_AGENT_SERVER_URL' -and
    $parts -contains 'QUANT_AGENT_TOKEN' -and
    $env:QUANT_AGENT_SERVER_URL -eq 'https://agent.example' -and
    $env:QUANT_AGENT_TOKEN -eq $script:Token
  )
  $script:LASTEXITCODE = 0
  $actionIndex = [Array]::IndexOf($parts, 'context')
  if ($actionIndex -lt 0) { $actionIndex = 2 }
  $action = $parts[$actionIndex]
  $subAction = if ($parts.Length -gt ($actionIndex + 1)) { $parts[$actionIndex + 1] } else { '' }
  if ($action -eq 'stop') { return 'stopped' }
  if ($action -eq 'rm') { return 'removed' }
  switch ("$action $subAction") {
    'context inspect' {
      if ($script:ContextFailures -gt 0) { $script:ContextFailures--; $script:LASTEXITCODE = 1; return }
      return 'npipe:////./pipe/dockerDesktopLinuxEngine'
    }
    'info --format' {
      if ($parts -contains '{{.Architecture}}') { return $script:EngineArchitecture }
      return 'linux'
    }
    'pull ghcr.io/sa04108/quant-agent:latest' {
      if ($parts[-1] -ne 'ghcr.io/sa04108/quant-agent:latest') { throw "Pull must receive the configured image: $($parts -join ' ')" }
      if ($script:FailPull) { $script:LASTEXITCODE = 1 }
      return 'pull complete'
    }
    'image inspect' { return ('sha256:' + ('a' * 64)) }
    'image rm' {
      if ($script:FailImageRemoval) { $script:LASTEXITCODE = 1 }
      return
    }
    'container inspect' {
      if ($script:ExistingContainer) {
        if ($parts -contains '{{.Image}}') { return $script:OldImageId }
        return $script:ExistingLabel
      }
      $script:LASTEXITCODE = 1
      return
    }
    'volume inspect' {
      if ($script:ExistingVolume) { return 'volume' }
      $script:LASTEXITCODE = 1
      return
    }
    'volume create' { $script:ExistingVolume = $true; return $parts[-1] }
    'run --detach' {
      $script:RanContainer = $true
      if ($script:FailRun) { $script:LASTEXITCODE = 1 }
      return 'container-id'
    }
    'inspect --format' { return 'true' }
    default { throw "Unexpected Docker invocation: $($parts -join ' ')" }
  }
}

function Get-Process {
  [CmdletBinding()]
  param([string] $Name)
  if ($script:DesktopRunning) { return [pscustomobject]@{ ProcessName = 'Docker Desktop' } }
}

function Start-Process([string] $FilePath) {
  if ($env:QUANT_AGENT_TOKEN -eq $script:Token) { throw 'Docker Desktop must not inherit the Agent token.' }
  $script:StartedDesktopAt = $FilePath
  $script:DesktopRunning = $true
}

function Start-Sleep([int] $Seconds) { }

function Invoke-InstallerFromHybrid([string] $InstallerPath) {
  $env:QUANT_AGENT_INSTALLER = $InstallerPath
  $contents = [IO.File]::ReadAllText($env:QUANT_AGENT_INSTALLER)
  $anchor = [Environment]::NewLine + $marker
  $index = $contents.IndexOf($anchor, [StringComparison]::Ordinal)
  if ($index -lt 0) { throw 'Could not locate anchored PowerShell payload.' }
  . ([scriptblock]::Create($contents.Substring($index + $anchor.Length)))
}

try {
  $null = New-Item -ItemType Directory -Path $root
  # PowerShell 함수 모킹이 숨기는 Windows 5.1의 네이티브 인자 변환도 확인한다.
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $probe = Join-Path $root 'native-argv.exe'
    Add-Type -TypeDefinition 'using System; public class NativeArgv { public static void Main(string[] args) { foreach (string arg in args) Console.WriteLine(arg); } }' -OutputAssembly $probe -OutputType ConsoleApplication
    $labelFormat = [regex]::Match($template, "'container', 'inspect', '--format', '([^']+)'").Groups[1].Value
    if (-not $labelFormat) { throw 'Container label format was not found in the installer.' }
    $nativeArguments = @(& $probe --format $labelFormat)
    Assert-Equal '--format' $nativeArguments[0] 'Native Docker format flag should be preserved'
    Assert-Equal $labelFormat $nativeArguments[1] 'Native Docker template should survive Windows argument conversion'
  }
  $fakeProgramFiles = Join-Path $root 'Program Files'
  $fakeLocalAppData = Join-Path $root 'Local AppData'
  $fakeBin = Join-Path $root 'bin'
  $desktopDir = Join-Path $fakeProgramFiles 'Docker\Docker'
  $desktopBin = Join-Path $desktopDir 'resources\bin'
  $null = New-Item -ItemType Directory -Path $desktopBin -Force
  $null = New-Item -ItemType Directory -Path $fakeBin -Force
  $desktopExe = Join-Path $desktopDir 'Docker Desktop.exe'
  $null = New-Item -ItemType File -Path $desktopExe
  $null = New-Item -ItemType File -Path (Join-Path $fakeBin 'docker.exe')
  $env:ProgramFiles = $fakeProgramFiles
  $env:LOCALAPPDATA = $fakeLocalAppData
  $env:Path = $fakeBin
  $env:DOCKER_HOST = 'tcp://old-daemon:2375'
  $env:DOCKER_CONTEXT = 'old-context'
  $env:DOCKER_TLS_VERIFY = '1'
  $env:DOCKER_TLS = '1'
  $env:DOCKER_CERT_PATH = 'C:\old-certs'
  $env:QUANT_AGENT_SERVER_URL = 'https://old.example'
  $env:QUANT_AGENT_TOKEN = 'old-token'
  $env:PROCESSOR_ARCHITECTURE = 'x86'
  $env:PROCESSOR_ARCHITEW6432 = 'AMD64'
  $installerEnvironment = @{}
  foreach ($key in @('Path', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_TLS', 'DOCKER_CERT_PATH', 'QUANT_AGENT_SERVER_URL', 'QUANT_AGENT_TOKEN')) {
    $installerEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  }
  $script:Token = 'test-agent-token-0123456789'
  $config = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress @{ serverUrl = 'https://agent.example'; token = $script:Token; image = 'ghcr.io/sa04108/quant-agent:latest' })))
  $installerPath = Join-Path $root "agent's installer.cmd"
  $payload = "$marker`r`n`$ConfigJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$config'))`r`n" + $template.Substring($template.IndexOf("`n") + 1)
  $hybrid = @('@echo off', 'setlocal', 'set "QUANT_AGENT_INSTALLER=%~f0"', 'exit /b 0', $payload) -join "`r`n"
  [IO.File]::WriteAllText($installerPath, $hybrid)

  $script:Calls = @()
  $script:DesktopRunning = $false
  $script:StartedDesktopAt = $null
  $script:ExistingContainer = $false
  $script:ExistingVolume = $false
  $script:FailPull = $false
  $script:FailRun = $false
  $script:FailImageRemoval = $false
  $script:ExistingLabel = 'quant-agent'
  $script:OldImageId = 'sha256:' + ('b' * 64)
  $script:EngineArchitecture = 'x86_64'
  $script:ContextFailures = 2
  $script:RanContainer = $false
  $script:RunSawExpectedEnvironment = $false
  Invoke-InstallerFromHybrid $installerPath
  Assert-Equal $desktopExe $script:StartedDesktopAt 'A stopped Desktop installation should be started'
  if (-not $script:Calls.Where({ $_ -match 'volume create quant-agent-' })) { throw 'The first install should create its persistent volume.' }
  if ($script:ContextFailures -ne 0) { throw 'The installer should retry until Docker Desktop creates the Linux context.' }
  if (-not $script:RanContainer) { throw 'The first install should run the container.' }
  if (-not $script:RunSawExpectedEnvironment) { throw 'Docker run should inherit token and server URL through environment names.' }
  if (-not ($script:Calls | Where-Object { $_ -match 'sha256:a{64}$' })) { throw 'Docker run should use the inspected image ID.' }
  foreach ($key in @('Path', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_TLS', 'DOCKER_CERT_PATH', 'QUANT_AGENT_SERVER_URL', 'QUANT_AGENT_TOKEN')) {
    Assert-Equal $installerEnvironment[$key] ([Environment]::GetEnvironmentVariable($key, 'Process')) "Environment variable $key should be restored"
  }

  $script:Calls = @()
  $script:ExistingContainer = $true
  $script:ExistingVolume = $true
  $script:FailPull = $true
  $script:RanContainer = $false
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected) { throw 'A pull failure should stop the install.' }
  if ($script:Calls | Where-Object { $_ -match ' (stop|rm) quant-agent-' }) { throw 'A pull failure must preserve the existing container.' }
  if ($script:RanContainer) { throw 'A pull failure must prevent replacement container start.' }

  $script:Calls = @()
  $script:FailPull = $false
  Invoke-InstallerFromHybrid $installerPath
  $stopIndex = Find-CallIndex ' stop quant-agent-'
  $removeIndex = Find-CallIndex ' rm quant-agent-'
  $runIndex = Find-CallIndex ' run --detach '
  $runningIndex = Find-CallIndex ' inspect --format .*State.Running'
  $imageRemovalIndex = Find-CallIndex ' image rm sha256:b{64}$'
  if ($stopIndex -lt 0 -or $removeIndex -le $stopIndex -or $runIndex -le $removeIndex -or $runningIndex -le $runIndex -or $imageRemovalIndex -le $runningIndex) { throw 'Replacement must remove the old container, confirm the new one is running, then remove the old image.' }
  if ($script:Calls | Where-Object { $_ -match ' volume (create|rm) ' }) { throw 'Replacement must preserve and reuse the existing volume.' }
  if (-not ($script:Calls | Where-Object { $_ -match ' --mount type=volume,source=quant-agent-.*-state,target=/var/lib/quant-agent ' })) { throw 'Replacement must mount its persistent state volume.' }

  $script:Calls = @()
  $script:FailRun = $true
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or ($script:Calls | Where-Object { $_ -match ' image rm ' })) { throw 'A run failure must preserve the old image.' }
  $script:FailRun = $false

  $script:Calls = @()
  $script:FailImageRemoval = $true
  Invoke-InstallerFromHybrid $installerPath 3>$null
  if (-not ($script:Calls | Where-Object { $_ -match ' image rm sha256:b{64}$' })) { throw 'A shared old image should be attempted without failing the installation.' }
  $script:FailImageRemoval = $false

  $script:Calls = @()
  $script:OldImageId = 'sha256:' + ('a' * 64)
  Invoke-InstallerFromHybrid $installerPath
  if ($script:Calls | Where-Object { $_ -match ' image rm ' }) { throw 'The current image must not be removed when the image ID is unchanged.' }

  foreach ($scenario in @('unrelated', 'invalid-image')) {
    $script:Calls = @()
    $script:ExistingLabel = if ($scenario -eq 'unrelated') { 'other-app' } else { 'quant-agent' }
    $script:OldImageId = 'invalid'
    $failedAsExpected = $false
    try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
    if (-not $failedAsExpected -or ($script:Calls | Where-Object { $_ -match ' (stop|rm|run) ' })) { throw "The $scenario container must be preserved." }
  }
  $script:ExistingLabel = 'quant-agent'
  $script:OldImageId = 'sha256:' + ('b' * 64)

  foreach ($scenario in @('host', 'engine')) {
    $script:Calls = @()
    $script:FailPull = $false
    $env:PROCESSOR_ARCHITEW6432 = ''
    if ($scenario -eq 'host') { $env:PROCESSOR_ARCHITECTURE = 'ARM64' }
    else { $env:PROCESSOR_ARCHITECTURE = 'AMD64'; $script:EngineArchitecture = 'aarch64' }
    $message = ''
    try { Invoke-InstallerFromHybrid $installerPath } catch { $message = $_.Exception.Message }
    if ($message -notmatch 'x64') { throw "Unsupported $scenario architecture should produce an x64 error." }
    if ($script:Calls | Where-Object { $_ -match ' (pull|stop|rm|run) ' }) { throw "Unsupported $scenario architecture must preserve the existing container and avoid pulling." }
  }

  Write-Output 'Windows Agent installer mock scenarios passed.'
} finally {
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
  }
  [Environment]::SetEnvironmentVariable('QUANT_AGENT_INSTALLER', $savedEnvironment['QUANT_AGENT_INSTALLER'], 'Process')
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
