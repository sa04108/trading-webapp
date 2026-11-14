#!/usr/bin/env bash
# 운영 원본을 데이터로 읽는다. 앱에 전달할 키와 Compose용 키를 명시적으로 구분한다.
APP_CONFIG_KEYS=(SESSION_SECRET SESSION_IDLE_TIMEOUT_SECONDS SESSION_ABSOLUTE_TIMEOUT_SECONDS
  AUDIT_LOG_RETENTION_DAYS NOTIFICATION_RETENTION_DAYS MAX_QUEUED_BACKTESTS LOG_LEVEL
  LIVE_TRADING_ENABLED SYNC_MIN_FREE_DISK_MB KRX_DAILY_CALL_BUDGET
  KRX_API_KEY KRX_APPROVAL_EXPIRY KRX_BASE_URL DART_API_KEY DART_BASE_URL FRED_API_KEY FRED_BASE_URL
  TOSS_CLIENT_ID TOSS_CLIENT_SECRET TOSS_BASE_URL AGENT_CONTAINER_IMAGE)
COMPOSE_CONFIG_KEYS=(DOMAIN SERVER_IMAGE SERVER_CPUS SERVER_MEMORY TRAEFIK_NETWORK
  TRAEFIK_HTTPS_ENTRYPOINT TRAEFIK_CERT_RESOLVER TRAEFIK_TRUSTED_IPS)
declare -A SETTINGS=()

read_server_config() {
  local file="$1" line key value number=0
  local -A allowed=() seen=()
  for key in "${APP_CONFIG_KEYS[@]}" "${COMPOSE_CONFIG_KEYS[@]}"; do allowed[$key]=1; done
  SETTINGS=([SERVER_IMAGE]=quant-platform:local [SERVER_CPUS]=3.0 [SERVER_MEMORY]=10g
    [TRAEFIK_NETWORK]=infra-proxy [TRAEFIK_HTTPS_ENTRYPOINT]=websecure
    [TRAEFIK_CERT_RESOLVER]=letsencrypt [TRAEFIK_TRUSTED_IPS]='')
  [[ -f "$file" ]] || { echo 'config.env가 없습니다. scripts/server.sh init을 실행하세요.' >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || {
      echo "config.env ${number}행: KEY=value 형식이어야 합니다." >&2; return 1;
    }
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    [[ -n "${allowed[$key]:-}" ]] || { echo "config.env ${number}행: 지원하지 않는 키 $key" >&2; return 1; }
    [[ -z "${seen[$key]:-}" ]] || { echo "config.env ${number}행: 중복 키 $key" >&2; return 1; }
    [[ "$value" != *$'\r'* ]] || { echo "config.env ${number}행: 값에 줄 구분 문자를 넣을 수 없습니다." >&2; return 1; }
    seen[$key]=1
    SETTINGS[$key]="$value"
  done < "$file"
  [[ "${SETTINGS[DOMAIN]:-}" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "${SETTINGS[DOMAIN]}" != *..* ]] || {
    echo 'config.env: DOMAIN에는 도메인 이름만 지정하세요.' >&2; return 1;
  }
  [[ "${SETTINGS[SERVER_IMAGE]}" =~ ^[a-z0-9][a-zA-Z0-9./:@_-]+$ ]] || { echo 'config.env: SERVER_IMAGE 형식이 올바르지 않습니다.' >&2; return 1; }
  [[ "${SETTINGS[SERVER_CPUS]}" =~ ^[0-9]+([.][0-9]+)?$ && "${SETTINGS[SERVER_CPUS]}" =~ [1-9] ]] || {
    echo 'config.env: SERVER_CPUS는 0보다 큰 수여야 합니다.' >&2; return 1;
  }
  [[ "${SETTINGS[SERVER_MEMORY]}" =~ ^[1-9][0-9]*([kKmMgG][bB]?|[bB])?$ ]] || {
    echo 'config.env: SERVER_MEMORY에는 10g 같은 양의 메모리 한도를 지정하세요.' >&2; return 1;
  }
  for key in TRAEFIK_NETWORK TRAEFIK_HTTPS_ENTRYPOINT TRAEFIK_CERT_RESOLVER; do
    [[ "$key" == TRAEFIK_CERT_RESOLVER && -z "${SETTINGS[$key]}" ]] && continue
    [[ "${SETTINGS[$key]}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo "config.env: $key 형식이 올바르지 않습니다." >&2; return 1; }
  done
  value="${SETTINGS[SESSION_SECRET]:-}"
  [[ ${#value} -ge 32 ]] || { echo 'config.env: SESSION_SECRET은 32자 이상이어야 합니다.' >&2; return 1; }
}

render_app_config() {
  local destination="$1" key
  # raw env_file이므로 값은 해석·확장·인용하지 않고 그대로 보존한다.
  {
    printf 'NODE_ENV=production\n'
    for key in "${APP_CONFIG_KEYS[@]}"; do
      if [[ -v "SETTINGS[$key]" ]]; then printf '%s=%s\n' "$key" "${SETTINGS[$key]}"; fi
    done
  } > "$destination"
}
