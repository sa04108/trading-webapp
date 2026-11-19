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
  if ($parts -contains 'run') {
    $script:RunToken = $env:QUANT_AGENT_TOKEN
    $markerLabel = @($parts | Where-Object { $_ -clike 'quant.agent.installation=*' })
    if ($markerLabel.Count -eq 1) { $script:ReplacementMarker = $markerLabel[0].Substring(25) }
  }
  $script:LASTEXITCODE = 0
  $actionIndex = [Array]::IndexOf($parts, 'context')
  if ($actionIndex -lt 0) { $actionIndex = 2 }
  $action = $parts[$actionIndex]
  $subAction = if ($parts.Length -gt ($actionIndex + 1)) { $parts[$actionIndex + 1] } else { '' }
  if ($action -eq 'stop') { return 'stopped' }
  if ($action -eq 'rm') { return 'removed' }
  if ($action -eq 'rename' -or $action -eq 'start') { return 'ok' }
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
    'ps --all' { return $script:CandidateIds }
    'container inspect' {
      if ($script:CandidateDetails -and $parts.Length -eq 5) {
        if ($parts[-1] -eq 'quant-agent-old' -and ($script:FailRun -or $script:FailAfterStart)) { return ConvertTo-Json -Compress -Depth 5 -InputObject @(@{ Id = ('c' * 64); Config = @{ Labels = @{ 'quant.agent.installation' = $script:ReplacementMarker } } }) }
        return $script:CandidateDetails[$parts[-1]]
      }
      if ($script:ExistingContainer) {
        if ($parts -contains '{{.State.Running}}') { return 'true' }
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
    'inspect --format' {
      if ($parts -contains '{{.State.Running}} {{.RestartCount}}') {
        $script:StateChecks++
        if ($script:FailAfterStart -and $script:StateChecks -gt 1) { return 'false 0' }
        return 'true 0'
      }
      return 'true'
    }
    default { throw "Unexpected Docker invocation: $($parts -join ' ')" }
  }
}

function Invoke-RestMethod {
  param($Method, $Uri, $ContentType, $Body, $Headers, $MaximumRedirection, $TimeoutSec)
  if ($MaximumRedirection -ne 0 -or $TimeoutSec -le 0) { throw 'Unexpected request settings.' }
  if ($Method -eq 'Post') {
    if ($Uri -cne 'https://agent.example/api/agents/install/resolve') { throw 'Unexpected credential request.' }
    $script:Requests += ,($Body | ConvertFrom-Json)
    $script:StatusChecks = 0
    $script:StateChecks = 0
    if ($script:FailResolve) { throw 'network failure' }
    return @{ id = 'device-1'; token = $script:ResolvedToken }
  }
  if ($Uri -cne 'https://agent.example/api/agents/install/status' -or $Headers.Authorization -cne ('Bearer ' + $script:ResolvedToken) -or $Headers.'Cache-Control' -cne 'no-store') { throw 'Unexpected status request.' }
  $script:StatusChecks++
  if ($script:FailStatus -and $script:StatusChecks -eq 1) { throw 'network failure' }
  if ($script:StatusChecks -eq 1) { return @{ ready = $true; connectionId = 'old-connection' } }
  if ($script:StatusChecks -eq 2) { return @{ ready = $false; connectionId = 'old-connection' } }
  return @{ ready = $true; connectionId = 'new-connection' }
}

function Set-InstallerConfig($Config) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress $Config)))
  $payload = "$marker`r`n`$ConfigJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encoded'))`r`n" + $template.Substring($template.IndexOf("`n") + 1)
  [IO.File]::WriteAllText($installerPath, (@('@echo off', 'exit /b 0', $payload) -join "`r`n"))
}

function New-Candidate([string] $Name, [string] $Server, [string] $Token, [string] $Device, [string] $MountType = 'volume') {
  return ConvertTo-Json -Depth 8 -Compress -InputObject @(@{
    Name = '/' + $Name
    Config = @{ Env = @(('QUANT_AGENT_SERVER_URL=' + $Server), ('QUANT_AGENT_TOKEN=' + $Token)); Labels = @{ app = 'quant-agent'; 'quant.agent.id' = $Device } }
    Mounts = @(@{ Destination = '/var/lib/quant-agent'; Type = $MountType; Name = 'retained-state' })
  })
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
    $script:OldImageId = if ($scenario -eq 'invalid-image') { 'invalid' } else { 'sha256:' + ('b' * 64) }
    $failedAsExpected = $false
    try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
    if ((Find-CallIndex ' container inspect --format .*Config.Labels.app') -lt 0) { throw "The $scenario scenario must reach the existing container." }
    if ($scenario -eq 'invalid-image' -and (Find-CallIndex ' container inspect --format .*Image') -lt 0) { throw 'The invalid image must be inspected.' }
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

  $env:PROCESSOR_ARCHITECTURE = 'AMD64'
  $script:EngineArchitecture = 'x86_64'
  $script:ExistingContainer = $true
  $script:ExistingVolume = $true
  $script:ResolvedToken = $script:Token
  $script:FailResolve = $false
  $script:CandidateIds = @('one')
  $script:CandidateDetails = @{ one = (New-Candidate 'quant-agent-old' 'https://agent.example' $script:Token 'device-1') }
  $newConfig = @{ serverUrl = 'https://agent.example'; image = 'ghcr.io/sa04108/quant-agent:latest'; installation = 'grant'; installationId = 'fallback'; containerName = 'quant-agent-123456789abc'; targetClientId = 'device-1' }
  Set-InstallerConfig $newConfig
  foreach ($replacementToken in @($script:Token, 'new-fallback-token')) {
    $script:Calls = @(); $script:Requests = @(); $script:ResolvedToken = $replacementToken
    Invoke-InstallerFromHybrid $installerPath
    Assert-Equal $script:Token $script:Requests[0].previousToken 'The selected token must be resolved'
    Assert-Equal $replacementToken $script:RunToken 'The resolved token must reach the replacement'
    if ($script:StatusChecks -ne 3) { throw 'A new ready connection is required before accepting the container.' }
    if (-not ($script:Calls | Where-Object { $_ -match ' --name quant-agent-old .*source=retained-state,target=/var/lib/quant-agent' })) { throw 'Replacement must retain the selected name and volume.' }
    if (-not ($script:Calls | Where-Object { $_ -match 'quant.agent.id=device-1' })) { throw 'Resolved identity must be labeled.' }
  }
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  try { $legacyHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:Token)))).Replace('-', '').ToLowerInvariant() }
  finally { $hashAlgorithm.Dispose() }
  $legacyConfig = @{ serverUrl = 'https://agent.example'; image = 'ghcr.io/sa04108/quant-agent:latest'; installation = 'grant'; installationId = 'fallback'; containerName = 'quant-agent-123456789abc'; targetClientId = 'device-1'; targetTokenHash = $legacyHash }
  $legacyCandidate = (New-Candidate 'quant-agent-old' 'https://agent.example' $script:Token 'unused' | ConvertFrom-Json)
  $legacyCandidate.Config.Labels.PSObject.Properties.Remove('quant.agent.id')
  $script:CandidateDetails.one = ConvertTo-Json -Depth 8 -Compress -InputObject @($legacyCandidate)
  Set-InstallerConfig $legacyConfig
  $script:Calls = @(); $script:Requests = @()
  Invoke-InstallerFromHybrid $installerPath
  Assert-Equal $script:Token $script:Requests[0].previousToken 'Legacy token hash must select the existing token'
  if (-not ($script:Calls | Where-Object { $_ -match ' --name quant-agent-old .*source=retained-state,target=/var/lib/quant-agent' })) { throw 'Legacy token hash selection must retain the old name and volume.' }

  $genericConfig = @{ serverUrl = 'https://agent.example'; image = 'ghcr.io/sa04108/quant-agent:latest'; installation = 'grant'; installationId = 'fallback'; containerName = 'quant-agent-123456789abc' }
  Set-InstallerConfig $genericConfig
  $script:CandidateIds = @(); $script:ExistingContainer = $false; $script:ExistingVolume = $false
  $script:Calls = @(); $script:Requests = @()
  Invoke-InstallerFromHybrid $installerPath
  if ($script:Requests[0].PSObject.Properties.Name -contains 'previousToken') { throw 'A new installation must not send a previous token.' }
  if (-not ($script:Calls | Where-Object { $_ -match ' volume create quant-agent-123456789abc-state$' }) -or
      -not ($script:Calls | Where-Object { $_ -match ' --name quant-agent-123456789abc .*source=quant-agent-123456789abc-state,target=/var/lib/quant-agent' }) -or
      $script:StatusChecks -ne 3) { throw 'A new installation must create its configured volume and confirm a new ready connection.' }
  Set-InstallerConfig $newConfig
  $script:CandidateIds = @('one'); $script:ExistingContainer = $true; $script:ExistingVolume = $true
  $script:CandidateDetails.one = New-Candidate 'quant-agent-old' 'https://agent.example' $script:Token 'device-1'

  $script:Calls = @(); $script:Requests = @(); $script:FailRun = $true
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or -not ($script:Calls | Where-Object { $_ -match ' rm --force c{64}$' }) -or
      -not ($script:Calls | Where-Object { $_ -match ' rename one quant-agent-old$' }) -or
      ($script:Calls | Where-Object { $_ -match ' start one$' })) { throw 'Failed replacement must restore the old container without starting it.' }
  $script:FailRun = $false
  $script:Calls = @(); $script:Requests = @(); $script:FailAfterStart = $true
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or $script:StatusChecks -ne 2 -or -not ($script:Calls | Where-Object { $_ -match ' rename one quant-agent-old$' }) -or
      ($script:Calls | Where-Object { $_ -match ' start one$' })) { throw 'A running container without a new ready connection must roll back if it stops.' }
  $script:FailAfterStart = $false
  $script:Calls = @(); $script:Requests = @(); $script:FailStatus = $true
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or ($script:Calls | Where-Object { $_ -match ' (stop|rm|run) ' })) { throw 'Status failure must preserve the existing container.' }
  $script:FailStatus = $false
  $script:Calls = @(); $script:Requests = @()
  Invoke-InstallerFromHybrid $installerPath
  if (-not ($script:Calls | Where-Object { $_ -match 'source=retained-state,target=/var/lib/quant-agent' })) { throw 'Retry must retain the original volume.' }

  $script:CandidateDetails.one = New-Candidate 'quant-agent-old' 'https://agent.example' '' 'device-1'
  $script:Calls = @(); $script:Requests = @()
  Invoke-InstallerFromHybrid $installerPath
  if ($script:Requests[0].PSObject.Properties.Name -contains 'previousToken') { throw 'Missing token must use the installation fallback.' }
  $script:CandidateDetails.one = New-Candidate 'quant-agent-old' 'https://agent.example' $script:Token 'device-1'

  $script:Calls = @(); $script:Requests = @(); $script:FailResolve = $true
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or ($script:Calls | Where-Object { $_ -match ' (stop|rm|run) ' })) { throw 'Credential failure must preserve the existing container.' }
  $script:FailResolve = $false

  $script:Calls = @(); $script:Requests = @()
  $script:CandidateIds = @('one', 'two')
  $script:CandidateDetails.two = New-Candidate 'quant-agent-other' 'https://other.example' 'other-secret' 'device-1'
  Invoke-InstallerFromHybrid $installerPath
  Assert-Equal 1 $script:Requests.Count 'Only one credential request should be sent'
  Assert-Equal $script:Token $script:Requests[0].previousToken 'A different server token must not be sent'

  $script:Calls = @(); $script:Requests = @()
  $script:CandidateDetails.two = New-Candidate 'quant-agent-other' 'https://agent.example' 'other-secret' 'device-1'
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or $script:Requests.Count -ne 0 -or ($script:Calls | Where-Object { $_ -match ' (stop|rm|run) ' })) { throw 'Ambiguous candidates must stop before authentication or replacement.' }

  $script:Calls = @(); $script:Requests = @(); $script:CandidateIds = @('one')
  $script:CandidateDetails.one = New-Candidate 'quant-agent-old' 'https://agent.example' $script:Token 'device-1' 'bind'
  $failedAsExpected = $false
  try { Invoke-InstallerFromHybrid $installerPath } catch { $failedAsExpected = $true }
  if (-not $failedAsExpected -or $script:Requests.Count -ne 0) { throw 'A bind mount must not be reused.' }

  Write-Output 'Windows Agent installer mock scenarios passed.'
} finally {
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
  }
  [Environment]::SetEnvironmentVariable('QUANT_AGENT_INSTALLER', $savedEnvironment['QUANT_AGENT_INSTALLER'], 'Process')
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
