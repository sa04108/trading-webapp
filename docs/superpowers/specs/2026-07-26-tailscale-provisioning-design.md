# Tailscale 기반 단일 명령 프로비저닝 — 설계

작성일: 2026-07-26
상태: 승인됨 (구현 대기)
관련: 스펙 §18~§30, D-016 (신규)

## 1. 문제

스펙 §21~§29 의 서버 구축이 수동 다단계로 흩어져 있다. `infra/lightsail/launch-script.sh`
가 §21·§22 만 덮고, 나머지는 사람이 순서를 지켜가며 실행해야 한다.

근본 원인은 편의성 부족이 아니라 **순수 WireGuard 의 구조적 제약**이다.

- Lightsail 의 공개키를 기존 WireGuard 서버에 peer 로 등록해야 터널이 선다.
- 그 등록은 이 리포 밖의 다른 머신에서 일어난다.
- 등록 전에는 핸드셰이크를 확인할 수 없고, 확인 못 하면 UFW 를 켤 수 없다 (락아웃).

즉 first-boot 스크립트로는 원리적으로 완주가 불가능하다. 요구사항은
"클라우드가 무엇이든 동일하게, 쉽고 빠르게" 이므로 이 제약 자체를 제거한다.

## 2. 결정

**WireGuard 를 Tailscale 로, Caddy 를 `tailscale serve` 로 대체한다.**

Tailscale 의 데이터 평면은 동일한 WireGuard 다. 보안 모델은 낮아지지 않는다.
바뀌는 것은 control plane 이 키 배포·주소 할당·NAT 통과·이름 해석·인증서를
대신한다는 점이며, 그 결과 수동 단계 8 개 중 6 개가 사라지고 자동화 불가였던
1 개(UFW 게이트)가 가능해진다.

핵심은 `tailscale up --authkey` 가 **비대화형 단일 명령으로 조인을 완결**한다는 것이다.
순수 WireGuard 에는 이에 대응하는 것이 없다.

### 대안 검토

- **공개 노출 + 도메인 + Let's Encrypt**: 앱이 유일한 방어선이 된다. D-014 로 TOTP 2FA 를
  제거한 상태와 정면 충돌하며, 재도입·rate limit·fail2ban 이 따라온다. 복잡도가 인프라에서
  애플리케이션으로 옮겨갈 뿐 총량이 줄지 않는다. 또한 Let's Encrypt 인증서는 Certificate
  Transparency 로그에 공개되어 호스트명이 즉시 스캐너에 노출된다.
- **현행 WireGuard 유지**: 보안·비용 최적이나 §1 의 제약으로 목표 달성이 불가능하다.

## 3. 아키텍처

리포의 기존 관례를 유지한다 — `scripts/` 는 개발 PC 진입점, `infra/` 는 서버에 놓이는 산출물.

```
개발 PC                              서버
──────────────────────────────────────────────────────────
scripts/bootstrap.sh <host>  ──▶  infra/provision.sh    1 회, 멱등
                                   §21·22·23·25·26·28·29
                                          │
scripts/deploy.sh <host>     ──▶  /opt/quant-platform/  매 릴리스
                                   releases/<release>
```

책임이 겹치지 않는다. bootstrap 은 **런타임 환경**, deploy 는 **애플리케이션**을 담당한다.
`scripts/deploy.sh` 는 수정하지 않는다.

`infra/provision.sh` 는 POSIX sh 로 작성하고 서버에서 root 로 실행하며 멱등이다.
각 단계가 현재 상태를 먼저 확인하고 필요할 때만 변경한다.

## 4. 락아웃 가드 — 2 단계 실행

UFW 적용에는 함정이 있다. `tailscale status` 가 Running 이라는 것은 **터널이 섰다**는
뜻이지 **그 터널로 SSH 인바운드가 실제로 된다**는 뜻이 아니다. 서버 위에서 도는
provision.sh 는 외부에서의 도달성을 스스로 검증할 수 없다.

UFW 가 퍼블릭 22 를 막으면 Lightsail 브라우저 SSH 콘솔도 함께 죽는다 (그것도 퍼블릭
IP:22 를 쓴다). 검증 없이 켜면 복구 수단이 전부 사라진다.

따라서 **검증 주체를 개발 PC 로 옮긴다.** provision.sh 를 두 모드로 나눈다.

| 모드 | 내용 | 실행 시점 |
|---|---|---|
| 기본 | §21·22·23·28·29 + `tailscale serve` | 퍼블릭 IP 경유 SSH |
| `--harden` | §25 UFW + §26 SSH 하드닝 | **tailnet 경유 SSH 가 실증된 뒤** |

bootstrap.sh 의 흐름:

1. 퍼블릭 IP 로 접속해 provision.sh 기본 모드 실행
2. 출력에서 FQDN 을 읽는다
3. `ssh ubuntu@<fqdn> true` 로 tailnet 경유 SSH 를 **실제로 시도**한다
4. 성공하면 tailnet 경유로 `provision.sh --harden` 실행
5. 실패하면 하드닝을 건너뛰고 경고와 수동 절차를 출력한다 (퍼블릭 SSH 는 살아 있다)

이렇게 하면 명령은 여전히 하나이면서, 락아웃 방지가 문서상의 주의사항이 아니라
**코드로 강제되는 불변식**이 된다. 스펙 §25 의 "WireGuard SSH 가 검증되기 전에 퍼블릭
SSH 세션을 차단하지 않는다" 를 사람의 규율이 아니라 제어 흐름으로 구현한 것이다.

전제: 개발 PC 가 tailnet 에 조인되어 있어야 한다. deploy.sh 도 어차피 tailnet 을 쓰므로
새로운 부담이 아니다.

## 5. 비밀값 취급

`scripts/deploy.sh` 헤더의 원칙 — "비밀값을 command line argument 로 넘기지 않는다" — 를
그대로 지킨다. auth key 는 `ps` 출력과 셸 히스토리에 남으면 안 된다.

```bash
TS_AUTHKEY=tskey-... ./scripts/bootstrap.sh 1.2.3.4   # 환경변수
./scripts/bootstrap.sh 1.2.3.4                        # 미설정 시 read -s 프롬프트
```

bootstrap.sh 는 이 값을 **stdin** 으로 원격 provision.sh 에 전달한다. argv 에도, 원격 셸
히스토리에도 남지 않는다.

`SESSION_SECRET` 은 주입하지 않는다. provision.sh 가 서버에서 `openssl rand -base64 48`
로 생성한다. 전송할 비밀값이 하나 줄어든다.

## 6. provision.sh 단계

멱등성 규칙: 모든 단계가 "이미 되어 있으면 건너뛴다". 두 번 실행한 결과가 한 번 실행한
결과와 같아야 한다.

### 기본 모드

1. **§21 기반** — 패키지, 타임존 UTC, `quant` 시스템 유저, 디렉터리 트리, 권한.
   `id quant` 확인, `mkdir -p`, `install` 사용.
2. **§22 Node 24** — 목표 버전은 provision.sh 상단의 `NODE_VERSION` 변수로 고정한다
   (프로비저닝 전 nodejs.org 의 현재 24.x LTS patch 로 갱신, SHA 는 자동 검증).
   `node --version` 이 목표 버전과 같으면 건너뛴다. 아니면 nodejs.org
   타르볼을 SHA256 검증 후 `/opt/node-<ver>` 에 풀고 `/opt/node` 심볼릭 링크와
   `/usr/local/bin` 링크 4 개를 건다. `corepack enable`.
3. **Tailscale 설치·조인** — 이미 `BackendState == "Running"` 이면 건너뛴다.
   ```
   tailscale up --authkey <stdin> --hostname quant-platform --advertise-tags=tag:server
   ```
   `--advertise-tags` 가 **노드 키 만료를 막는다**. 태그 노드는 만료 대상에서 제외된다.
   헤드리스 서버가 어느 날 조용히 tailnet 에서 떨어지는 사고를 막는 필수 조치다.
4. **FQDN 확정** — `tailscale status --json` 의 `Self.DNSName` 을 읽는다.
   **이름을 가정하지 않는다.** 같은 호스트명의 노드가 이미 존재하면 Tailscale 이
   `quant-platform-1` 처럼 접미사를 붙이므로, 재프로비저닝 시 조용히 달라진다.
5. **`tailscale serve`** — 443 을 `127.0.0.1:3000` 으로 프록시하도록 설정한다.
   TLS 인증서 발급과 90 일 주기 갱신을 데몬이 처리한다.
6. **§28 app.env** — 파일이 **없을 때만** 생성한다. `infra/app.env.example` 을 바탕으로
   `SESSION_SECRET` 만 생성값으로 치환하고 `root:root`, `600` 으로 설치한다.
   이미 있으면 절대 덮지 않는다 — 덮으면 기존 세션이 전부 무효화된다.
7. **§29 systemd** — `infra/systemd/quant-platform.service` 를 설치하고 `daemon-reload`,
   `enable` 한다. **start 하지 않는다** — 아직 `dist` 가 없다. 첫 기동은 deploy.sh 가 한다.
8. **요약 출력** — FQDN, 다음 명령(`deploy.sh`, `admin:create`), 하드닝 상태.

### `--harden` 모드

9. **§25 UFW** — `default deny incoming`, `default allow outgoing`,
   `allow in on tailscale0 to any port 22 proto tcp`. §25 의 443 규칙은 필요 없을
   것으로 보인다 — `tailscale serve` 는 tailscaled 프로세스 안에서 종단되어 443 이
   tailscale0 인터페이스의 인바운드 패킷으로 나타나지 않는다 (실측 확인 항목).
   앱은 `127.0.0.1` 에만 바인딩하므로 3000 을 명시적으로 막을
   필요가 없다 (기본 거부가 덮는다).
   직접 연결 성능을 위해 UDP 41641 인바운드를 여는 것은 선택 사항이다 — 막혀 있어도
   DERP 릴레이로 동작하며, 개인 대시보드 수준의 트래픽에서는 체감 차이가 없다.
10. **§26 SSH 하드닝** — `/etc/ssh/sshd_config.d/99-quant-hardening.conf` 설치 후
    `sshd -t` 로 검증하고 `systemctl restart ssh` (유닛명은 `sshd` 가 아니라 `ssh` 다).

§24 Lightsail 콘솔 방화벽은 UFW 가 이미 덮으므로 **선택적 심층방어**로 강등하고 README 에만
남긴다. 클라우드 종속 단계를 자동화 경로에서 제외해 인프라를 클라우드 무관으로 유지한다.

## 7. 파일 변경

| 동작 | 경로 | 사유 |
|---|---|---|
| 삭제 | `infra/lightsail/launch-script.sh` | provision.sh 에 흡수. auth key 가 비밀값이라 first-boot 로는 완주 불가하며, 남기면 §21·§22 의 진실이 두 곳이 된다 |
| 삭제 | `infra/wireguard/wg0.conf.example` | Tailscale 로 대체 |
| 삭제 | `infra/caddy/Caddyfile` | `tailscale serve` 가 TLS 종단 |
| 삭제 | `infra/systemd/caddy-override.conf` | Caddy 제거로 무의미 |
| 삭제 | `infra/ufw/setup-ufw.sh` | provision.sh `--harden` 에 흡수 |
| 추가 | `infra/provision.sh` | 서버 프로비저닝 본체 (POSIX sh) |
| 추가 | `scripts/bootstrap.sh` | 개발 PC 래퍼 (bash, deploy.sh 와 동일 관례) |
| 수정 | `src/server/shared/security.ts` | 기존 `SECURITY_HEADERS` 에 HSTS 추가 |
| 수정 | `src/server/bootstrap/server.ts` | `@fastify/compress` 등록 |
| 수정 | `package.json` | `@fastify/compress` 추가 |
| 수정 | `README.md` | 배포 섹션 교체 |
| 수정 | `docs/DECISIONS.md` | D-016 추가 |
| 유지 | `infra/systemd/quant-platform.service`, `infra/app.env.example` | provision.sh 가 설치 |

`infra/lightsail/` 이 비어 사라진다. 결과적으로 `infra/` 전체가 클라우드 무관해진다.

## 8. Caddy 제거의 애플리케이션 영향

앱은 이미 `src/server/shared/security.ts` 의 `SECURITY_HEADERS`(onSend 훅)로
CSP·`X-Content-Type-Options`·`X-Frame-Options`·`Referrer-Policy` 를 설정하고 있다
(스펙 §16). Caddyfile 과 겹치는 세 헤더는 중복이었고, Caddy 를 빼도 사라지지 않는다.

Caddyfile 이 하던 것 중 앱에 없는 것은 **HSTS 하나**다.

| Caddy 기능 | 이전 후 |
|---|---|
| TLS 종단 (자체서명 CA) | `tailscale serve` — 신뢰되는 인증서, 갱신 포함 |
| `:443` → `127.0.0.1:3000` | `tailscale serve` |
| `Strict-Transport-Security` | `SECURITY_HEADERS` 에 1 줄 추가 |
| 나머지 보안 헤더 3 종 | 이미 앱에 있음 — 변경 없음 |
| `encode zstd gzip` | `@fastify/compress` |
| `-Server` | 불필요 — Fastify 는 `Server` 헤더를 보내지 않는다. 해당 지시어는 Caddy 자신의 헤더를 지우던 것이다 |

```
Strict-Transport-Security: max-age=31536000
```

SSE 응답은 `reply.hijack()` 으로 훅을 우회하므로 `@fastify/compress` 의 영향을 받지
않는다 (`security.ts` 가 같은 이유로 `SECURITY_HEADERS` 를 상수로 노출한다).

`trustProxy` 는 변경하지 않는다. `tailscale serve` 도 `127.0.0.1` 에서 프록시하므로
`TRUST_PROXY_LOOPBACK=true` 가 여전히 올바르다.

원칙 확인: HTTP 응답 정책은 애플리케이션 계층이며 앱이 인프라를 알게 되지 않는다.
스펙 §2.1 에 저촉되지 않는다. 오히려 엣지를 무엇으로 바꾸든 헤더가 따라다니게 되므로
현재 상태보다 개선이다.

## 9. tailnet 사전 설정 (평생 1 회)

인스턴스마다가 아니라 계정에 한 번이다. README 에 체크리스트로 기록한다.

1. MagicDNS 활성화
2. HTTPS 인증서 활성화
3. ACL 정책에 `tag:server` 의 `tagOwners` 정의 — 3 단계의 `--advertise-tags` 가 이것 없이는
   실패한다
4. 프로비저닝마다 auth key 발급: **pre-authorized, `tag:server` 태그, 비 ephemeral**.
   ephemeral 키는 노드가 오프라인이 되면 제거되므로 상시 서버에 부적합하다

## 10. 검증

- `dash -n` 구문 검사 (Lightsail 이 launch script 를 dash 로 실행해 실제로 깨진 전례가 있다)
- 실제 인스턴스에서 **2 회 연속 실행하여 결과 동일** — 멱등성 실증
- 보안 헤더 4 종을 `app.inject()` 단위 테스트로 검증 (기존 vitest 인프라 사용)
- 기존 게이트 전부 유지: lint, typecheck, 64 unit/integration, 3 E2E
- **최종 판정 기준**: 새 인스턴스 → `bootstrap.sh` 1 회 → `deploy.sh` 1 회 → 휴대폰에서
  `https://<fqdn>` 로그인 화면 도달. 중간에 다른 머신을 건드리지 않는다.

### 구현 중 실측 확인 항목

문서상 동작이나 90 일 뒤 조용히 깨지는 종류이므로 가정하지 않고 박스에서 확인한다.

- `tailscale serve` 설정이 재부팅 후에도 유지되는가
- TLS 인증서 자동 갱신이 데몬에 의해 실제로 처리되는가
- UFW 에 tailscale0 포트 22 만 열어도 `tailscale serve` 를 통한 443 접속이 되는가
  (serve 는 tailscaled 내부 종단이라 UFW 를 거치지 않는다는 가정의 실증) — 안 되면
  `allow in on tailscale0 to any port 443 proto tcp` 를 추가한다

두 번째가 아니라면 `tailscale cert` + systemd timer 로 대체한다.

## 11. 범위 밖

- Lightsail 인스턴스 생성 자동화 (클라우드 종속 어댑터 계층)
- `scripts/deploy.sh` 수정
- 백업·복구 스크립트 수정
- tailnet lock, 세분화된 ACL 규칙 — 단일 사용자 단계에서 YAGNI
