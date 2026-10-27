#__AGENT_POWERSHELL_PAYLOAD__
$ErrorActionPreference = 'Stop'
$config = $ConfigJson | ConvertFrom-Json
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $tokenHash = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.token)))).Replace('-', '').ToLowerInvariant().Substring(0, 12) }
finally { $sha256.Dispose() }
$containerName = 'quant-agent-' + $tokenHash
$volumeName = $containerName + '-state'
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

  Write-Host '최신 Agent 이미지를 내려받습니다...'
  Invoke-Docker -Arguments @('pull', $config.image)
  $imageResult = Invoke-DockerQuery -Arguments @('image', 'inspect', '--format', '{{.Id}}', $config.image)
  $imageId = ($imageResult.Output -join '').Trim()
  if ($imageResult.ExitCode -ne 0 -or $imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw '내려받은 이미지 확인에 실패했습니다.' }

  $containerResult = Invoke-DockerQuery -Arguments @('container', 'inspect', '--format', '{{.Config.Labels.app}}', $containerName)
  if ($containerResult.ExitCode -eq 0) {
    $existingLabel = ($containerResult.Output -join '').Trim()
    if ($existingLabel -ne 'quant-agent') { throw '같은 이름의 Agent가 아닌 컨테이너가 있어 안전하게 교체하지 않았습니다.' }
    Invoke-Docker -Arguments @('stop', $containerName)
    Invoke-Docker -Arguments @('rm', $containerName)
  }

  $volumeResult = Invoke-DockerQuery -Arguments @('volume', 'inspect', $volumeName)
  if ($volumeResult.ExitCode -ne 0) { Invoke-Docker -Arguments @('volume', 'create', $volumeName) | Out-Null }

  $env:QUANT_AGENT_SERVER_URL = $config.serverUrl
  $env:QUANT_AGENT_TOKEN = $config.token
  try {
    Invoke-Docker -Arguments @(
      'run', '--detach', '--init', '--restart', 'unless-stopped', '--name', $containerName,
      '--label', 'app=quant-agent', '--mount', "type=volume,source=$volumeName,target=/var/lib/quant-agent",
      '--env', 'QUANT_AGENT_SERVER_URL', '--env', 'QUANT_AGENT_TOKEN', $imageId
    ) | Out-Null
  } finally {
    $env:QUANT_AGENT_SERVER_URL = $oldServerUrl
    $env:QUANT_AGENT_TOKEN = $oldToken
  }
  $running = $false
  $runDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $runDeadline) {
    $stateResult = Invoke-DockerQuery -Arguments @('inspect', '--format', '{{.State.Running}}', $containerName)
    if ($stateResult.ExitCode -eq 0 -and ($stateResult.Output -join '').Trim() -eq 'true') { $running = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $running) { throw 'Agent 컨테이너가 계속 실행되지 않습니다. 아래 로그 명령으로 원인을 확인하세요: docker --context desktop-linux logs ' + $containerName }

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
