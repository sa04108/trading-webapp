#__AGENT_POWERSHELL_PAYLOAD__
$ErrorActionPreference = 'Stop'
$config = $ConfigJson | ConvertFrom-Json
$newMode = -not [string]::IsNullOrWhiteSpace($config.installation)
$containerName = $config.containerName
$volumeName = $containerName + '-state'
if (-not $newMode) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $tokenHash = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.token)))).Replace('-', '').ToLowerInvariant().Substring(0, 12) }
  finally { $sha256.Dispose() }
  $containerName = 'quant-agent-' + $tokenHash
  $volumeName = $containerName + '-state'
}
$dockerContext = 'desktop-linux'
$oldDockerHost = $env:DOCKER_HOST
$oldDockerContext = $env:DOCKER_CONTEXT
$oldDockerTlsVerify = $env:DOCKER_TLS_VERIFY
$oldDockerTls = $env:DOCKER_TLS
$oldDockerCertPath = $env:DOCKER_CERT_PATH
$oldServerUrl = $env:QUANT_AGENT_SERVER_URL
$oldToken = $env:QUANT_AGENT_TOKEN
$oldPath = $env:Path

function Invoke-Docker([string[]] $Arguments) {
  & docker --context $dockerContext @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker 명령이 실패했습니다 (exit $LASTEXITCODE)." }
}

function Invoke-DockerQuery([string[]] $Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& docker --context $dockerContext @Arguments 2>$null)
    return @{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Get-DockerDesktopExecutable {
  $locations = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe')
  )
  foreach ($location in $locations) {
    if (Test-Path -LiteralPath $location -PathType Leaf) { return $location }
  }
  return $null
}

try {
  $hostArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($hostArchitecture -ne 'AMD64') { throw '이 Agent는 x64 Windows에서만 지원됩니다. ARM 또는 다른 아키텍처에서는 설치할 수 없습니다.' }
  $env:DOCKER_HOST = ''
  $env:DOCKER_CONTEXT = ''
  $env:DOCKER_TLS_VERIFY = ''
  $env:DOCKER_TLS = ''
  $env:DOCKER_CERT_PATH = ''

  $desktopExe = Get-DockerDesktopExecutable
  if (-not $desktopExe) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
      throw 'Docker Desktop이 없고 winget도 찾을 수 없습니다. Windows App Installer를 설치한 뒤 다시 실행하세요.'
    }
    Write-Host 'Docker Desktop을 설치합니다. 설치 확인이나 재부팅이 필요할 수 있습니다.'
    & winget.exe install --id Docker.DockerDesktop --exact --source winget --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop 설치가 완료되지 않았습니다. 안내된 설치 절차를 마친 뒤 다시 실행하세요.' }
    $desktopExe = Get-DockerDesktopExecutable
    if (-not $desktopExe) { throw 'Docker Desktop을 설치했습니다. 설치 안내를 마친 뒤 이 파일을 다시 실행하세요.' }
  }

  $desktopBin = Join-Path (Split-Path -Parent $desktopExe) 'resources\bin'
  if (Test-Path -LiteralPath $desktopBin -PathType Container) { $env:Path = "$desktopBin;$env:Path" }
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop이 있지만 docker.exe를 찾을 수 없습니다. Docker Desktop 설치를 복구한 뒤 다시 실행하세요.'
  }

  if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    Write-Host 'Docker Desktop을 시작합니다...'
    Start-Process -FilePath $desktopExe
  }

  $deadline = [DateTime]::UtcNow.AddMinutes(5)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $contextResult = Invoke-DockerQuery -Arguments @('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', $dockerContext)
    if ($contextResult.ExitCode -eq 0) {
      $desktopEndpoint = ($contextResult.Output -join '').Trim()
      if ($desktopEndpoint -ne 'npipe:////./pipe/dockerDesktopLinuxEngine') {
        throw 'desktop-linux 컨텍스트가 Docker Desktop Linux 엔진을 가리키지 않습니다. Docker Desktop을 복구한 뒤 다시 실행하세요.'
      }
      $engineResult = Invoke-DockerQuery -Arguments @('info', '--format', '{{.OSType}}')
      if ($engineResult.ExitCode -eq 0) {
        $osType = ($engineResult.Output -join '').Trim()
        if ($osType -eq 'windows') {
          throw 'Docker Desktop이 Windows 컨테이너 모드입니다. Docker Desktop에서 Linux 컨테이너로 전환한 뒤 다시 실행하세요.'
        }
        if ($osType -eq 'linux') { $ready = $true; break }
      }
    }
    Start-Sleep -Seconds 3
  }
  if (-not $ready) { throw 'Docker Desktop Linux 엔진이 준비되지 않았습니다. Docker Desktop을 시작하고 Linux 컨테이너 설정을 마친 뒤 다시 실행하세요.' }

  $architectureResult = Invoke-DockerQuery -Arguments @('info', '--format', '{{.Architecture}}')
  $engineArchitecture = ($architectureResult.Output -join '').Trim()
  if ($architectureResult.ExitCode -ne 0 -or $engineArchitecture -notin @('x86_64', 'amd64')) {
    throw '이 Agent는 x64 Docker Linux 엔진에서만 지원됩니다. Docker 엔진 아키텍처를 확인하세요.'
  }

  $selectedContainer = $false
  $agentId = $null
  if ($newMode) {
    $origin = $null
    if (-not [Uri]::TryCreate($config.serverUrl, [UriKind]::Absolute, [ref]$origin) -or
        $origin.Scheme -cne 'https' -or $origin.AbsolutePath -cne '/' -or
        $origin.Query -or $origin.Fragment -or $origin.UserInfo -or
        $origin.GetLeftPart([UriPartial]::Authority) -cne $config.serverUrl -or
        $containerName -cnotmatch '^quant-agent-[a-f0-9]{12}$') {
      throw 'Agent 설치 설정이 올바르지 않습니다.'
    }
    $list = Invoke-DockerQuery -Arguments @('ps', '--all', '--quiet', '--filter', 'label=app=quant-agent')
    if ($list.ExitCode -ne 0) { throw '기존 Agent 목록을 확인하지 못했습니다.' }
    $candidates = @()
    foreach ($id in $list.Output) {
      if ([string]::IsNullOrWhiteSpace($id)) { continue }
      $details = Invoke-DockerQuery -Arguments @('container', 'inspect', $id)
      if ($details.ExitCode -ne 0) { throw '기존 Agent 정보를 확인하지 못했습니다.' }
      try { $items = @(($details.Output -join "`n") | ConvertFrom-Json) }
      catch { throw '기존 Agent 정보를 확인하지 못했습니다.' }
      if ($items.Count -ne 1) { throw '기존 Agent 정보를 확인하지 못했습니다.' }
      $item = $items[0]
      $serverValues = @($item.Config.Env | Where-Object { $_ -clike 'QUANT_AGENT_SERVER_URL=*' })
      $tokenValues = @($item.Config.Env | Where-Object { $_ -clike 'QUANT_AGENT_TOKEN=*' })
      if ($serverValues.Count -ne 1 -or $serverValues[0].Substring(23) -cne $config.serverUrl) { continue }
      if ($item.Config.Labels.app -cne 'quant-agent') { continue }
      if ($tokenValues.Count -gt 1) { throw '기존 Agent 토큰을 확인하지 못했습니다.' }
      $previousToken = if ($tokenValues.Count -eq 1) { $tokenValues[0].Substring(18) } else { '' }
      $previousHash = ''
      if ($previousToken) {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { $previousHash = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($previousToken)))).Replace('-', '').ToLowerInvariant() }
        finally { $sha256.Dispose() }
      }
      $labelId = $item.Config.Labels.'quant.agent.id'
      $targeted = -not [string]::IsNullOrWhiteSpace($config.targetClientId) -or -not [string]::IsNullOrWhiteSpace($config.targetTokenHash)
      if ($targeted -and -not (($config.targetClientId -and $labelId -ceq $config.targetClientId) -or
          ($config.targetTokenHash -and $previousHash -ceq $config.targetTokenHash) -or
          ($config.installationId -and $labelId -ceq $config.installationId))) { continue }
      $candidates += @{ Item = $item; Token = $previousToken; Id = $id }
    }
    if ($candidates.Count -gt 1) { throw '같은 서버의 Agent가 여러 개입니다. 웹에서 장치별 설치 파일을 내려받아 실행하세요.' }
    $request = @{ installation = $config.installation }
    if ($candidates.Count -eq 1) {
      $candidate = $candidates[0]
      $mounts = @($candidate.Item.Mounts | Where-Object { $_.Destination -ceq '/var/lib/quant-agent' })
      if ($mounts.Count -ne 1 -or $mounts[0].Type -cne 'volume' -or [string]::IsNullOrWhiteSpace($mounts[0].Name)) {
        throw '기존 Agent 상태 볼륨을 확인하지 못했습니다.'
      }
      $containerName = ([string]$candidate.Item.Name).TrimStart('/')
      if ($containerName -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') { throw '기존 Agent 이름을 확인하지 못했습니다.' }
      $volumeName = $mounts[0].Name
      if ($candidate.Token) { $request.previousToken = $candidate.Token }
      $selectedContainer = $true
      $selectedId = $candidate.Id
    }
    try {
      $response = Invoke-RestMethod -Method Post -Uri ($config.serverUrl + '/api/agents/install/resolve') -ContentType 'application/json' -Body (ConvertTo-Json -Compress $request) -MaximumRedirection 0 -TimeoutSec 30
    } catch { throw 'Agent 인증 정보를 확인하지 못했습니다. 네트워크와 설치 파일을 확인하세요.' }
    if ([string]::IsNullOrWhiteSpace($response.id) -or [string]::IsNullOrWhiteSpace($response.token) -or $response.id -cnotmatch '^[a-zA-Z0-9_-]+$') {
      throw '서버에서 받은 Agent 인증 정보가 올바르지 않습니다.'
    }
    $agentId = $response.id
    $config | Add-Member -NotePropertyName token -NotePropertyValue $response.token -Force
    $statusHeaders = @{ Authorization = 'Bearer ' + $response.token; 'Cache-Control' = 'no-store' }
    try {
      $previousStatus = Invoke-RestMethod -Method Get -Uri ($config.serverUrl + '/api/agents/install/status') -Headers $statusHeaders -MaximumRedirection 0 -TimeoutSec 30
      if ($previousStatus.ready -isnot [bool] -or ($null -ne $previousStatus.connectionId -and $previousStatus.connectionId -isnot [string])) { throw 'invalid' }
      $previousConnectionId = $previousStatus.connectionId
    } catch { throw '기존 Agent 연결 상태를 확인하지 못했습니다.' }
  }

  Write-Host '최신 Agent 이미지를 내려받습니다...'
  Invoke-Docker -Arguments @('pull', $config.image)
  $imageResult = Invoke-DockerQuery -Arguments @('image', 'inspect', '--format', '{{.Id}}', $config.image)
  $imageId = ($imageResult.Output -join '').Trim()
  if ($imageResult.ExitCode -ne 0 -or $imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw '내려받은 이미지 확인에 실패했습니다.' }

  if ($selectedContainer) {
    $existingVolume = Invoke-DockerQuery -Arguments @('volume', 'inspect', $volumeName)
    if ($existingVolume.ExitCode -ne 0) { throw '기존 Agent 상태 볼륨을 확인하지 못했습니다.' }
  }

  $oldImageId = $null
  $backupName = $null
  $backupWasRunning = $false
  $replacementMarker = [Guid]::NewGuid().ToString('N')
  $existingTarget = if ($selectedContainer) { $selectedId } else { $containerName }
  $containerResult = Invoke-DockerQuery -Arguments @('container', 'inspect', '--format', '{{.Config.Labels.app}}', $existingTarget)
  if ($selectedContainer -and $containerResult.ExitCode -ne 0) { throw '기존 Agent가 사라져 교체하지 않았습니다.' }
  if ($containerResult.ExitCode -eq 0) {
    if ($newMode -and -not $selectedContainer) { throw '새 Agent 이름이 이미 사용 중입니다.' }
    $existingLabel = ($containerResult.Output -join '').Trim()
    if ($existingLabel -ne 'quant-agent') { throw '같은 이름의 Agent가 아닌 컨테이너가 있어 안전하게 교체하지 않았습니다.' }
    $oldImageResult = Invoke-DockerQuery -Arguments @('container', 'inspect', '--format', '{{.Image}}', $existingTarget)
    $oldImageId = ($oldImageResult.Output -join '').Trim()
    if ($oldImageResult.ExitCode -ne 0 -or $oldImageId -notmatch '^sha256:[a-f0-9]{64}$') { throw '기존 Agent 이미지 확인에 실패하여 교체하지 않았습니다.' }
    Write-Host "기존 Agent 컨테이너를 교체합니다: $containerName"
    if ($selectedContainer) {
      $state = Invoke-DockerQuery -Arguments @('container', 'inspect', '--format', '{{.State.Running}}', $existingTarget)
      if ($state.ExitCode -ne 0 -or ($state.Output -join '').Trim() -notin @('true', 'false')) { throw '기존 Agent 실행 상태를 확인하지 못했습니다.' }
      $backupWasRunning = ($state.Output -join '').Trim() -eq 'true'
      if ($backupWasRunning) { Invoke-Docker -Arguments @('stop', $existingTarget) | Out-Null }
      $backupName = $containerName + '-backup-' + $replacementMarker
      try { Invoke-Docker -Arguments @('rename', $existingTarget, $backupName) | Out-Null }
      catch {
        if ($backupWasRunning) { Invoke-DockerQuery -Arguments @('start', $existingTarget) | Out-Null }
        throw '기존 Agent를 안전하게 보관하지 못했습니다.'
      }
    } else {
      Invoke-Docker -Arguments @('stop', $existingTarget)
      Invoke-Docker -Arguments @('rm', $existingTarget)
    }
  }

  $runAttempted = $false
  try {
    $volumeResult = Invoke-DockerQuery -Arguments @('volume', 'inspect', $volumeName)
    if ($volumeResult.ExitCode -ne 0) {
      if ($selectedContainer) { throw '기존 Agent 상태 볼륨을 확인하지 못했습니다.' }
      Invoke-Docker -Arguments @('volume', 'create', $volumeName) | Out-Null
    } else { Write-Host "기존 Agent 상태 볼륨을 유지합니다: $volumeName" }

    $env:QUANT_AGENT_SERVER_URL = $config.serverUrl
    $env:QUANT_AGENT_TOKEN = $config.token
    try {
      $labels = @('--label', 'app=quant-agent')
      if ($agentId) { $labels += @('--label', ('quant.agent.id=' + $agentId)) }
      if ($backupName) { $labels += @('--label', ('quant.agent.installation=' + $replacementMarker)) }
      $runAttempted = $true
      Invoke-Docker -Arguments (@('run', '--detach', '--init', '--restart', 'unless-stopped', '--name', $containerName) + $labels + @('--mount', "type=volume,source=$volumeName,target=/var/lib/quant-agent",
        '--env', 'QUANT_AGENT_SERVER_URL', '--env', 'QUANT_AGENT_TOKEN', $imageId)) | Out-Null
    } finally {
      $env:QUANT_AGENT_SERVER_URL = $oldServerUrl
      $env:QUANT_AGENT_TOKEN = $oldToken
    }
    $running = $false
    $runDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $runDeadline) {
      if ($newMode) {
        $stateResult = Invoke-DockerQuery -Arguments @('inspect', '--format', '{{.State.Running}} {{.RestartCount}}', $containerName)
        $stateText = ($stateResult.Output -join '').Trim()
        if ($stateResult.ExitCode -ne 0 -or $stateText -cne 'true 0') { throw 'Agent 컨테이너가 종료되었거나 재시작되었습니다.' }
        $remaining = [Math]::Max(1, [Math]::Min(5, [Math]::Ceiling(($runDeadline - [DateTime]::UtcNow).TotalSeconds)))
        try {
          $status = Invoke-RestMethod -Method Get -Uri ($config.serverUrl + '/api/agents/install/status') -Headers $statusHeaders -MaximumRedirection 0 -TimeoutSec $remaining
          if ($status.ready -is [bool] -and $status.ready -and $status.connectionId -is [string] -and
              -not [string]::IsNullOrWhiteSpace($status.connectionId) -and $status.connectionId -cne $previousConnectionId) {
            $running = $true
            break
          }
        } catch { }
      } else {
        $stateResult = Invoke-DockerQuery -Arguments @('inspect', '--format', '{{.State.Running}}', $containerName)
        if ($stateResult.ExitCode -eq 0 -and ($stateResult.Output -join '').Trim() -eq 'true') { $running = $true; break }
      }
      Start-Sleep -Seconds 2
    }
    if (-not $running) { throw 'Agent 연결을 확인하지 못했습니다.' }
  } catch {
    if ($backupName) {
      $replacement = Invoke-DockerQuery -Arguments @('container', 'inspect', $containerName)
      $canRestore = $replacement.ExitCode -ne 0
      if ($replacement.ExitCode -eq 0) {
        try { $replacementItems = @(($replacement.Output -join "`n") | ConvertFrom-Json) }
        catch { $replacementItems = @() }
        if ($replacementItems.Count -eq 1 -and $replacementItems[0].Config.Labels.'quant.agent.installation' -ceq $replacementMarker -and
            $replacementItems[0].Id -cmatch '^[a-f0-9]{64}$') {
          $removed = Invoke-DockerQuery -Arguments @('rm', '--force', $replacementItems[0].Id)
          $canRestore = $removed.ExitCode -eq 0
        }
      }
      if ($canRestore) {
        $restored = Invoke-DockerQuery -Arguments @('rename', $existingTarget, $containerName)
        if ($restored.ExitCode -eq 0 -and $backupWasRunning -and -not $runAttempted) { Invoke-DockerQuery -Arguments @('start', $existingTarget) | Out-Null }
      }
      throw 'Agent 교체에 실패했습니다. 기존 컨테이너와 상태 볼륨을 확인하세요.'
    }
    throw
  }
  if ($backupName) {
    $removedBackup = Invoke-DockerQuery -Arguments @('rm', $existingTarget)
    if ($removedBackup.ExitCode -ne 0) { Write-Warning "기존 Agent 백업 컨테이너를 삭제하지 못했습니다: $backupName" }
  }

  if ($oldImageId -and $oldImageId -ne $imageId) {
    $removeResult = Invoke-DockerQuery -Arguments @('image', 'rm', $oldImageId)
    if ($removeResult.ExitCode -ne 0) { Write-Warning "이전 Agent 이미지를 삭제하지 못했습니다 (다른 컨테이너나 태그가 사용 중일 수 있습니다): $oldImageId" }
    else { Write-Host "이전 Agent 이미지를 삭제했습니다: $oldImageId" }
  }

  Write-Host "Agent가 실행 중입니다: $containerName"
  Write-Host "로그 보기: docker --context $dockerContext logs --follow $containerName"
  Write-Host "상태 확인: docker --context $dockerContext ps --filter name=$containerName"
} finally {
  $env:DOCKER_HOST = $oldDockerHost
  $env:DOCKER_CONTEXT = $oldDockerContext
  $env:DOCKER_TLS_VERIFY = $oldDockerTlsVerify
  $env:DOCKER_TLS = $oldDockerTls
  $env:DOCKER_CERT_PATH = $oldDockerCertPath
  $env:QUANT_AGENT_SERVER_URL = $oldServerUrl
  $env:QUANT_AGENT_TOKEN = $oldToken
  $env:Path = $oldPath
}
