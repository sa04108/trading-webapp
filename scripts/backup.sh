#!/usr/bin/env bash
# 스펙 §31 — 일봉·재무 fact를 포함한 SQLite + export 백업. 비밀값은 백업하지 않는다.
# 서버에서 실행. S3 사용 시 별도 제한 IAM 사용자로만 업로드한다.
set -euo pipefail

DATA_DIR="/var/lib/quant-platform"
BACKUP_DIR="${DATA_DIR}/backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/backup-${STAMP}"
# 작성 중에는 backup-* 이름을 쓰지 않는다 — 완성된 것만 rename 으로 그 이름을 얻는다.
# 반쪽 디렉터리가 backup-* 로 보이면 보관 개수에 끼어 BACKUP_MIN_KEEP 의 보장
# ("복원 가능한 백업이 항상 남는다") 이 빈 껍데기로 채워진다.
STAGING="${BACKUP_DIR}/.incomplete-${STAMP}"

# 로컬 보관은 일수가 아니라 총 용량으로 제한한다 (D-013). 디스크는 40GB 고정인데
# 백업 1벌의 크기는 exports 와 함께 자라므로 "30일" 은 총량을 묶어주지 못한다.
# 스펙 §31 의 30일 lifecycle 은 S3 쪽 규칙이고, 그쪽은 이 제약을 받지 않는다.
BACKUP_MAX_TOTAL_MB="${BACKUP_MAX_TOTAL_MB:-10240}"
# 상한을 넘겨도 이 개수는 남긴다 — 복원할 백업이 0벌이 되는 상태를 만들지 않는다
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-2}"

mkdir -p "${BACKUP_DIR}"

# 강제 종료(OOM·정전)로 남은 과거 작업본 정리. 하루가 지난 것만 건드려
# 동시 실행 중인 백업의 작업본을 지우지 않는다.
find "${BACKUP_DIR}" -maxdepth 1 -type d -name '.incomplete-*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true

# 이름이 backup-YYYYmmdd-HHMMSS 라 사전순 = 시간순 (오래된 것부터)
list_backups() {
  find "${BACKUP_DIR}" -maxdepth 1 -type d -name 'backup-*' | sort
}

backups_total_mb() {
  local sum=0 size dir
  while IFS= read -r dir; do
    [ -n "${dir}" ] || continue
    size="$(du -sm "${dir}" | cut -f1)"
    sum=$((sum + size))
  done < <(list_backups)
  echo "${sum}"
}

# 총량이 상한 이하가 될 때까지 가장 오래된 백업부터 삭제한다 (BACKUP_MIN_KEEP 까지만)
prune_to_cap() {
  local cap_mb="$1" count total oldest
  while :; do
    count="$(list_backups | wc -l)"
    if [ "${count}" -le "${BACKUP_MIN_KEEP}" ]; then break; fi
    total="$(backups_total_mb)"
    if [ "${total}" -le "${cap_mb}" ]; then break; fi
    oldest="$(list_backups | head -1)"
    echo "백업 총량 ${total}MB > ${cap_mb}MB — 가장 오래된 백업 삭제: ${oldest}" >&2
    rm -rf "${oldest}"
  done
}

# 생성 전 선정리: 이번 백업이 직전 백업만 하다고 보고 그만큼 여유를 미리 확보한다.
# 꽉 찬 디스크에서 백업을 만들다 ENOSPC 로 죽으면 반쪽짜리 백업만 남는다.
NEWEST="$(list_backups | tail -1)"
RESERVE_MB=0
if [ -n "${NEWEST}" ]; then
  RESERVE_MB="$(du -sm "${NEWEST}" | cut -f1)"
fi
prune_to_cap "$(( BACKUP_MAX_TOTAL_MB > RESERVE_MB ? BACKUP_MAX_TOTAL_MB - RESERVE_MB : 0 ))"

# 어느 단계에서 실패하든 작업본은 남기지 않는다 (성공 시 rename 후 trap 해제)
trap 'rm -rf "${STAGING}"' EXIT
mkdir -p "${STAGING}"

# SQLite 는 온라인 백업 API 사용 (WAL 안전)
sqlite3 "${DATA_DIR}/app.sqlite" ".backup '${STAGING}/app.sqlite'"

if [ -d "${DATA_DIR}/exports" ]; then
  tar -czf "${STAGING}/exports.tar.gz" -C "${DATA_DIR}" exports
fi

# 여기까지 왔으면 완성본이다 — 같은 디렉터리 안 rename 이라 원자적이다
mv "${STAGING}" "${TARGET}"
trap - EXIT

# 이번 백업을 포함해 상한을 다시 적용한다
prune_to_cap "${BACKUP_MAX_TOTAL_MB}"

echo "backup written to ${TARGET} (로컬 보관 $(list_backups | wc -l)벌 / $(backups_total_mb)MB, 상한 ${BACKUP_MAX_TOTAL_MB}MB)"

# 선택: S3 업로드 (Block Public Access + Versioning + 최소 IAM)
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "${TARGET}" "s3://${BACKUP_S3_BUCKET}/quant-platform/${STAMP}/" --recursive
fi
