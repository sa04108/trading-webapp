#!/usr/bin/env bash

# 현재 실행·배포 후보 핀을 확인한 뒤 이 프로젝트의 로컬 서버 이미지만 정리한다.
prune_server_images() {
  local pin ref id listing containers tagged dangling
  local -A protected=()
  [[ -s .server-image ]] || {
    echo '현재 운영 이미지 핀이 없어 이미지 정리를 건너뜁니다.' >&2
    return 1
  }
  local -a pins=(.server-image .server-update-pending)
  # 동시 자동·수동 빌드는 각자 후보 핀을 보유해 서로 덮어쓰지 않는다.
  for pin in .server-build-candidates/*; do
    [[ -e "$pin" || -L "$pin" ]] && pins+=("$pin")
  done
  for pin in "${pins[@]}"; do
    if [[ -e "$pin" || -L "$pin" ]]; then
      ref="$(cat "$pin")" || return 1
      if [[ -z "$ref" ]] || ! id="$(docker image inspect --format '{{.Id}}' "$ref")" ||
        [[ ! "$id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        echo "복구 이미지 핀을 확인하지 못해 이미지 정리를 건너뜁니다: $pin" >&2
        return 1
      fi
      protected["$id"]=1
    fi
  done
  # 직전 이미지를 별도 보관하던 과거 정책의 기록은 더 이상 사용하지 않는다.
  rm -f -- .server-image.previous || return 1
  # 정지한 컨테이너도 이미지를 참조한다. Docker의 강제 없는 삭제로 경합도 막는다.
  containers="$(docker ps --all --quiet)" || return 1
  if [[ -n "$containers" ]]; then
    local -a ids=()
    mapfile -t ids <<< "$containers"
    listing="$(docker inspect --format '{{.Image}}' "${ids[@]}")" || return 1
    while IFS= read -r id; do
      [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
      protected["$id"]=1
    done <<< "$listing"
  fi
  tagged="$(docker image ls --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}')" || return 1
  dangling="$(docker image ls --no-trunc --quiet --filter dangling=true \
    --filter label=org.opencontainers.image.source=https://github.com/sa04108/trading-webapp \
    --filter 'label=org.opencontainers.image.title=Quant Platform')" || return 1
  while read -r id ref; do
    [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || continue
    [[ -z "${protected[$id]:-}" ]] || continue
    case "$ref" in
      'quant-platform:<none>'|'ghcr.io/sa04108/quant-platform:<none>')
        docker image rm --no-prune "$id" || echo "서버 미태그 이미지 정리 실패: $id" >&2
        ;;
      quant-platform:*|ghcr.io/sa04108/quant-platform:*)
        docker image rm --no-prune "$ref" || echo "서버 이미지 정리 실패: $ref" >&2
        ;;
    esac
  done <<< "$tagged"
  while IFS= read -r id; do
    [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || continue
    [[ -z "${protected[$id]:-}" ]] || continue
    docker image rm --no-prune "$id" || echo "서버 임시 이미지 정리 실패: $id" >&2
  done <<< "$dangling"
}

cleanup_server_storage() {
  # 빌드부터 후보 핀 저장까지의 구간과 겹치면 다음 정리로 미룬다.
  exec 8>.server-build.lock
  if ! flock -n 8; then
    echo '서버 이미지를 빌드 중이어서 저장 공간 정리를 건너뜁니다.' >&2
    exec 8>&-
    return 0
  fi
  prune_server_images || echo '서버 이미지 정리를 완료하지 못했습니다.' >&2
  exec 8>&-
  # 정리 실패가 이미 성공한 배포를 실패 상태로 바꾸지 않는다.
  return 0
}
