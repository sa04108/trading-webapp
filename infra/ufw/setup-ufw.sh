#!/usr/bin/env bash
# 스펙 §25 — wg0 인터페이스의 22/443 만 허용, 나머지 인바운드 차단.
# 주의: WireGuard 로 SSH 가 검증되기 전에 퍼블릭 SSH 세션을 차단하지 않는다.
set -euo pipefail

sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow in on wg0 to any port 22 proto tcp
sudo ufw allow in on wg0 to any port 443 proto tcp

sudo ufw deny 80/tcp
sudo ufw deny 3000/tcp

sudo ufw enable
sudo ufw status verbose
