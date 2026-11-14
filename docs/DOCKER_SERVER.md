# Docker 서버 운영

기본 운영 대상은 Ubuntu 26.04 LTS의 GMKtec NucBox G3(N100 4코어, RAM 16GB, NVMe 256GB)다. 앱 Compose에는 `server` 하나만 두고 **기존 Traefik 3.7.16**으로 HTTPS를 제공한다. Linux/systemd 설치는 [README의 선택 경로](../README.md#first-deployment)로 유지한다. 고정 공인 IP 설정과 DB 백업·이전 자동화는 포함하지 않는다.

## 준비

- Linux amd64용 Docker Engine과 Compose 플러그인 **2.30 이상**을 [Docker 공식 Ubuntu 설치 안내](https://docs.docker.com/engine/install/ubuntu/)에 따라 준비한다. `docker info`, `docker compose version`으로 현재 계정의 실행 권한을 확인한다. 호스트 Node.js·pnpm은 필요 없다. Bash, Git, `flock`(util-linux), coreutils를 사용한다.
- 기존 Traefik의 Docker provider가 활성화되어 있고 `infra-proxy` 네트워크에 연결되어 있어야 한다. 앱은 같은 **external network**를 사용하며 이 네트워크나 Traefik을 생성·삭제하지 않는다. `docker network inspect infra-proxy`로 존재 여부를 확인한다.
- HTTPS entryPoint는 `websecure`, 인증서 resolver는 `letsencrypt`를 사용한다. Traefik의 인증서 저장·갱신, TCP 80/443 게시와 HTTP→HTTPS 전환은 기존 Traefik 설정에서 관리한다.
- `trading.hyunbbai.com`의 DNS와 공유기 포트 전달이 Traefik의 공개 진입점을 향해야 한다. 앱의 3000번 포트는 호스트에 게시하지 않는다.
- [이미지 게시 workflow](GITHUB_ACTIONS_DEPLOY.md)가 `main`에서 성공하여 서버·Agent 이미지가 GHCR에 있어야 한다. **devel 병합만으로 이미지를 게시하거나 서버를 배포하지 않는다.** 공개 패키지 설정 전에는 GHCR 읽기 권한으로 로그인해야 한다.

## 최초 실행

미니 PC에서 저장소를 받고 운영할 릴리스와 같은 체크아웃을 사용한다.

```bash
git clone --branch main https://github.com/sa04108/trading-webapp.git
cd trading-webapp
bash scripts/server.sh init
nano server.env
nano app.env
```

`server.env`의 기본 구성은 다음과 같다. `DOMAIN`에는 URL 전체가 아닌 도메인만 입력한다.

```dotenv
DOMAIN=trading.hyunbbai.com
TRAEFIK_NETWORK=infra-proxy
TRAEFIK_HTTPS_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=letsencrypt
SERVER_CPUS=3.0
SERVER_MEMORY=10g
```

`app.env`는 앱 설정과 API 키다. `init`은 권한 600으로 파일을 만들고 `SESSION_SECRET`을 생성하며 기존 파일을 덮어쓰지 않는다. 기존 DB를 가져오는 경우 필요한 기존 `SESSION_SECRET`도 유지한다. `app.env`는 셸로 실행하지 않으며 Compose가 원문 값으로 읽는다. 값에 셸 따옴표를 붙이지 않고 `$`도 그대로 입력한다. 키를 이미지나 Git에 넣지 않는다.

새 DB인 경우 서버를 처음 공개하기 전에 관리자와 TOTP를 등록한다. 기존 DB에 이미 계정이 있으면 반복하지 않는다.

```bash
bash scripts/server.sh cli admin:create
bash scripts/server.sh cli totp:enroll
bash scripts/server.sh up
bash scripts/server.sh status
```

CLI는 같은 이미지와 데이터 볼륨을 사용한다. 모든 CLI 명령은 서버를 중지한 상태에서만 실행할 수 있다. 첫 `up`은 이미지를 내려받고 DB 준비 후 서버 readiness를 확인한다. Traefik이 Docker label을 읽어 도메인 요청을 내부 3000번 포트로 전달한다. HTTPS 로그인과 설정 → Agent의 연결 상태를 확인한다. 서버 healthcheck만으로 Traefik·DNS·인증서 상태까지 확인됐다고 간주하지 않는다.

## 프록시와 전달 IP

Compose는 `traefik.enable`, 도메인 Host 규칙, `websecure`, TLS, `letsencrypt`, 내부 서비스 포트 3000을 label로 설정한다. 사용자 환경의 이름이 다르면 `server.env`에서 변경한다. 외부에서 공급하는 인증서를 쓴다면 `TRAEFIK_CERT_RESOLVER=`로 비워 둘 수 있다.

클라이언트 IP를 로그인 기록 등에 반영하려면 `TRAEFIK_TRUSTED_IPS`에 **Traefik의 정확한 Docker 내부 IP**를 입력한다. 공인 고정 IP와 별개의 설정이다. 값이 비어 있으면 전달 헤더를 신뢰하지 않으며 기록에는 직접 연결한 프록시 주소가 남는다. 공유 네트워크 전체를 무조건 신뢰하지 않는다. 여러 주소는 쉼표로 구분하며 CIDR은 신뢰할 프록시만 있는 전용 네트워크에 한해 사용한다. Traefik의 내부 IP가 바뀌면 설정을 갱신하고 `up`을 실행한다.

Traefik은 WebSocket·SSE도 전달한다. 앱 업데이트 명령은 기존 Traefik을 재시작하지 않는다. 502·404 또는 인증서 문제가 있으면 `infra-proxy` 연결, 라우터·서비스 label, Traefik 로그와 기존 인증서 resolver 설정을 확인한다.

## G3 기본 자원

| 범위 | 기본값 |
| --- | --- |
| 서버 컨테이너 전체(API·수집·계산 자식 포함) | CPU 3개, 메모리 10GiB |
| 서버 내부 계산 | 동시 작업 1개, 작업 메모리 예산 최대 약 5GiB |
| 유니버스 독립 계산 | 여유 CPU·메모리에 따라 최대 3개 스레드 |
| 병렬 유니버스 준비의 부모·스레드 old-space | 작업 예산에 비례, 최소 128MiB·최대 1GiB/격리 실행 영역 |
| 유니버스 보조 프로세스 | 작업 예산 이내 RSS 최대 2GiB, old-space 최대 약 819MiB |

호스트에 약 6GiB와 CPU 여유를 남기고, 컨테이너 안에서도 API용 메모리 절반을 예약한다. 기존 Traefik의 자원 설정은 해당 스택에서 관리한다. 위 값은 사전 점유량이 아닌 한도다. 실제 가용 메모리·부하·상위 cgroup 한도에 따라 작업 예산과 병렬도가 줄어든다. 5GiB 예산/3스레드에서는 준비 부모와 각 스레드의 old-space가 약 426MiB다. V8 힙은 전체 RSS와 다르며 SQLite·버퍼·스레드·자식까지 합친 최종 상한은 Docker가 적용한다.

일자별 거래와 보유 상태의 순서는 유지한다. 독립적인 유니버스 계산을 병렬 실행하며, 다수 외부 Agent의 자원 배정과 메모리 압력 감시는 유지한다. 작은 서버에서는 기존의 작은 예산을 사용한다. 메모리가 부족할 때 무조건 실행하도록 보호 장치를 해제하지 않는다. 한도 변경 후에는 `up`으로 재생성한다. 실제 데이터의 처리 시간·최대 RSS는 데이터와 전략에 따라 달라지므로 G3에서 관측한다.

## 상태·데이터·로그

```bash
bash scripts/server.sh status
bash scripts/server.sh logs server
docker stats --no-stream
bash scripts/server.sh stop
```

서버는 비 root UID 1000, 읽기 전용 이미지와 쓰기 가능한 데이터 볼륨·임시 디렉터리로 실행한다. `quant-platform_server_data` 볼륨의 `/var/lib/quant-platform`에 운영 DB `app.sqlite`, 계산 DB `app.data.sqlite`, 데이터·작업 상태를 보존한다. 컨테이너를 재생성해도 볼륨은 유지된다. 직접 데이터를 준비할 때 UID 1000이 읽고 쓸 수 있어야 한다. DB 파일뿐 아니라 기존 데이터 참조 경로도 확인한다. 이 도구는 백업·복원을 수행하지 않는다.

`docker compose down -v`는 앱 데이터 볼륨을 삭제하므로 일반 중지에는 사용하지 않는다. 앱 로그는 Docker `local` 드라이버로 20MiB × 5개까지 회전한다. `unless-stopped`는 종료된 프로세스와 Docker 재기동에 대응하지만, healthcheck가 `unhealthy`인 것만으로 자동 재시작하지 않는다. 종료 유예는 120초다.

## 업데이트와 실패 처리

```bash
git pull --ff-only
bash scripts/server.sh update
# 특정 릴리스 지정도 가능하다.
bash scripts/server.sh update ghcr.io/sa04108/quant-platform:sha-<커밋SHA>
```

업데이트는 서버 이미지 다운로드 → 앱 서비스 중지 → 후보 이미지의 `db:prepare` → readiness 확인 순서다. 성공한 서버 digest를 `.server-image`에 기록하여 이후 `up`이 같은 이미지를 실행한다. 기존 pin은 `.server-image.previous`에 남는다. `pnpm deploy`는 같은 업데이트 명령의 별칭이며, `pnpm deploy:systemd`는 기존 SSH 배포 경로다.

DB 준비·기동 실패 시 앱은 중지 상태로 남고 `.server-update-pending`에 후보 digest를 보존한다. 일반 `up`과 CLI는 차단된다. 로그를 확인하고 **기록된 같은 digest**로 업데이트를 재시도한다.

```bash
bash scripts/server.sh logs
bash scripts/server.sh update "$(cat .server-update-pending)"
```

다른 버전으로 되돌릴 때는 운영자가 DB·데이터·이미지 호환성을 함께 확인하고 필요한 복원을 수행한다. 이전 이미지 기록만으로 자동 롤백하지 않는다. pending 파일은 복구 상태가 확인된 뒤에만 수동 정리하며, 직접 `docker compose up`으로 이 차단을 우회하지 않는다. 같은 프로젝트의 변경 작업은 helper의 잠금으로 직렬화한다.

Docker 서버에는 같은 릴리스의 Agent 이미지 digest가 내장된다. 서버 업데이트 후 버전 불일치가 표시되면 설정 → Agent에서 저장한 기존 활성 토큰으로 Agent 설치 파일을 다시 내려받아 실행한다. 같은 토큰은 기존 장치와 캐시 볼륨을 유지한다. 토큰을 보관하지 않았다면 기존 장치를 해제하고 새 토큰을 발급하며, 이 경우 별도 캐시 볼륨을 사용한다. 이전 서버·설치 파일이 참조하는 이미지를 workflow에서 자동 삭제하지 않는다.
