#!/usr/bin/env bash
# 스펙 §31 — SQLite + 시간봉 Parquet + export 백업. 비밀값은 백업하지 않는다.
# 서버에서 실행. S3 사용 시 별도 제한 IAM 사용자로만 업로드한다.
set -euo pipefail

DATA_DIR="/var/lib/quant-platform"
BACKUP_DIR="${DATA_DIR}/backups"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/backup-${STAMP}"

mkdir -p "${TARGET}"

# SQLite 는 온라인 백업 API 사용 (WAL 안전)
sqlite3 "${DATA_DIR}/app.sqlite" ".backup '${TARGET}/app.sqlite'"

# 시간봉 Parquet (1분봉은 필요 시 S3 아카이브).
# 주의: tar 생성 시 인자는 리터럴 경로다 — --wildcards 는 생성에 적용되지 않으므로
# find 로 실제 경로를 열거해서 넘긴다 (깊이 무관: dataset=<id>/ 계층 포함).
if [ -d "${DATA_DIR}/market-data" ]; then
  if find "${DATA_DIR}/market-data" -type d -name 'timeframe=1h' | grep -q .; then
    (
      cd "${DATA_DIR}"
      find market-data -type d -name 'timeframe=1h' -print0 \
        | tar -czf "${TARGET}/market-data-1h.tar.gz" --null -T -
    )
  else
    echo "warning: no 1h market data found — skipping market-data archive" >&2
  fi
fi

if [ -d "${DATA_DIR}/exports" ]; then
  tar -czf "${TARGET}/exports.tar.gz" -C "${DATA_DIR}" exports
fi

# 30일 지난 로컬 백업 정리
find "${BACKUP_DIR}" -maxdepth 1 -type d -name 'backup-*' -mtime +30 -exec rm -rf {} +

echo "backup written to ${TARGET}"

# 선택: S3 업로드 (Block Public Access + Versioning + 최소 IAM)
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "${TARGET}" "s3://${BACKUP_S3_BUCKET}/quant-platform/${STAMP}/" --recursive
fi
