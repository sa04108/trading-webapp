#!/usr/bin/env bash
# 스펙 §31 — 백업 복원. 월 1회 복원 테스트에 사용한다.
# 사용법: ./scripts/restore.sh /var/lib/quant-platform/backups/backup-YYYYMMDD-HHMMSS
set -euo pipefail

SOURCE="${1:?usage: restore.sh <backup-dir>}"
DATA_DIR="/var/lib/quant-platform"

[ -f "${SOURCE}/app.sqlite" ] || { echo "app.sqlite not found in ${SOURCE}"; exit 1; }

echo "==> 서비스 중지"
sudo systemctl stop quant-platform

echo "==> SQLite 복원"
sudo cp "${SOURCE}/app.sqlite" "${DATA_DIR}/app.sqlite"
sudo rm -f "${DATA_DIR}/app.sqlite-wal" "${DATA_DIR}/app.sqlite-shm"

if [ -f "${SOURCE}/market-data-1h.tar.gz" ]; then
  echo "==> Parquet 복원"
  sudo tar -xzf "${SOURCE}/market-data-1h.tar.gz" -C "${DATA_DIR}"
fi

sudo chown -R quant:quant "${DATA_DIR}"

echo "==> 서비스 시작"
sudo systemctl start quant-platform
sleep 3
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
echo "restore complete"
