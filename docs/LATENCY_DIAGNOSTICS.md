# 운영 지연 진단

## 앱 로그의 위치와 조회

OpenTelemetry와 별도 로그 DB는 도입하지 않는다. 기존 Fastify/Pino가 JSON을 stdout에 쓰고,
`quant-platform.service`의 systemd-journald가 수집한다. 현재 운영 호스트의 영구 journal은
`/var/log/journal`에 있으며 파일을 직접 읽지 않고 `journalctl`로 조회한다. 새 진단은
`audit_logs`나 앱 SQLite에 저장하지 않는다. 기존 작업 감사 기록은 그대로 유지한다.

| 이벤트 | 내용 |
| --- | --- |
| `http.request.slow` | 1초 이상인 일반 HTTP 응답, reqId·route template·상태·시간 |
| `http.request.failed`, `http.request.aborted` | 최종 4xx/5xx와 응답 전 접속 종료; SSE·파일 스트림 수명은 지연에서 제외 |
| `diagnostic.stage.started/finished` | 검증·수집·스냅샷 게시 시작/끝, 250ms 이상인 SQL·외부 요청·원문 캐시·파싱·저장 |
| `preparation.phase`, `collection.phase` | 단계 변경·해소 반복 횟수·이전 단계 소요 시간 |
| `agent.data_request.mapped/deferred` | jobId와 dataRequestId 연결, 재시도 횟수·대기 이유·다음 시각 |
| `backtest.queue.waiting` | 실행기 없음·용량 부족·슬롯 사용 중·게시/배정 대기. 최대 20건을 분당 한 번 기록 |
| `runtime.event_loop_lag` | 5초 창에서 200ms 이상인 이벤트 루프 지연·타이머 지연, CPU·RSS·heap·external·GC |

단계 시간은 단조 시계로 측정한다. `COMPLETED`는 해당 단계의 실행 완료이며 제출 승인과는
다르다. `rest.fetch_headers`는 응답 헤더 수신까지, `rest.response_body_and_json`은 본문 수신과
JSON 디코딩을 합친 시간이다. CPU와 경과 시간을 함께 보고 계산과 대기를 구분한다.
CPU 수치는 해당 프로세스의 구간 내 사용량이므로 동시 작업도 포함하며, 중첩된 단계의
시간·CPU를 합산하지 않는다. 제출 검증 자식의 수치는 HTTP 부모의 수치와 별개다.
준비 단계 시간은 서버가 받은 진행 메시지 사이의 시간이라 전송 지연도 포함한다.

```bash
# 현재 로그
journalctl -u quant-platform.service -f -o cat | jq -R -c 'fromjson? | select(.event != null)'

# 한 요청의 검증 단계와 마지막 단계 찾기
journalctl -u quant-platform.service --since '30 minutes ago' -o cat \
  | jq -R -c --arg id 'req-예시' 'fromjson? | select(.reqId == $id)'

# 한 작업의 준비·용량 대기와 공유 수집 요청 ID 찾기
journalctl -u quant-platform.service --since '2 hours ago' -o cat \
  | jq -R -c --arg id 'bt_또는_prep_예시' 'fromjson? | select(.jobId == $id or .preparationJobId == $id)'

# 위 mapped 이벤트에서 얻은 공유 수집 요청의 세부 단계
journalctl -u quant-platform.service --since '2 hours ago' -o cat \
  | jq -R -c --arg id '공유수집요청ID' 'fromjson? | select(.dataRequestId == $id)'
```

일반 INFO 로그가 보이도록 운영 `LOG_LEVEL=info`를 사용한다. 새 진단에는 요청 본문·쿼리·헤더,
API 키·토큰·SQL 바인딩·팩트 원문을 남기지 않는다. 지연 직전 시작 로그가 있고 종료 로그가
없으면 해당 단계에서 정지했거나 프로세스가 종료됐을 가능성이 있다. 앱 자체가 멈추면
아래 호스트 표본을 함께 확인한다.

## 독립 호스트 관측

이 문서는 앱 이벤트 루프가 멈춘 동안에도 호스트 압력을 남기기 위한 **수동 설치용**
sampler와 조회 절차다. 이 저장소의 배포 파일을 바꾸지 않으며, 설치·활성화는 운영자가
별도로 판단하고 수행한다.

`quant-host-sample.timer`는 15초마다 독립적인 oneshot 프로세스를 실행한다. 프로세스는
`/proc`과 `quant-platform.service`의 cgroup 파일만 읽고, 앱 DB·네트워크·자격 증명·명령행을
읽거나 쓰지 않는다. 이전 counter는 `/run/quant-platform-diagnostics/host-sample.json`에만
600 권한으로 잠시 보관한다. 첫 표본의 delta는 `null`이며 다음 표본부터 해석한다.

## 설치와 중지

저장소의 파일을 운영 서버에 전달한 뒤 다음 예시를 수동으로 실행한다. 일반 앱 release에
진단 스크립트가 포함된다고 가정하지 않고 고정 경로에 별도로 설치한다. 서비스 계정은
현재 앱과 같은 `quant`이며 Python 3가 필요하다.

```bash
sudo install -D -m 0644 scripts/diagnostics/host-sample.py /usr/local/lib/quant-platform/host-sample.py
sudo install -m 0644 infra/diagnostics/quant-host-sample.service /etc/systemd/system/quant-host-sample.service
sudo install -m 0644 infra/diagnostics/quant-host-sample.timer /etc/systemd/system/quant-host-sample.timer
sudo systemctl daemon-reload
sudo systemctl enable --now quant-host-sample.timer
systemctl list-timers quant-host-sample.timer
```

중지는 다음과 같다.

```bash
sudo systemctl disable --now quant-host-sample.timer
sudo rm -f /etc/systemd/system/quant-host-sample.service /etc/systemd/system/quant-host-sample.timer
sudo systemctl daemon-reload
```

sampler 자체는 `sudo`를 호출하지 않는다. `systemctl show`는 최대 2초만 기다리며 전체
oneshot timeout은 5초, 메모리는 32MiB, CPU는 한 코어의 10%로 제한한다.
systemd 또는 cgroup을 읽지 못하는 개발 환경에서는 `cgroup:null`과
제한된 `errors`를 남기고 `/proc` 표본은 계속 출력한다.

## 표본 필드와 임계값

JSON의 `measurement_window_ms`는 이전 표본 이후의 실제 시간이다. timer 지연이나 앱 정지
후에는 15,000보다 클 수 있으므로, counter delta를 초당 값으로 해석하기 전에 이 값을
나눠야 한다.

| 필드 | 단위 | 해석 기준 |
| --- | --- | --- |
| `host.cpu_util_pct` | % | host CPU busy 비율. 낮은 값과 높은 I/O wait가 함께면 CPU 계산보다 저장장치 대기를 의심한다. |
| `host.iowait_pct` | % | `/proc/stat` tick delta의 I/O wait 비율. 15초 표본에서 지속적으로 20% 이상이면 I/O 원인 후보다. |
| `host.steal_pct` | % | 가상화 호스트가 다른 작업에 CPU를 사용한 비율. 앱 계산 과부하와 구분한다. |
| `host.mem.mem_available_bytes` | bytes | host가 바로 할당 가능한 메모리. 909MiB 호스트에서 급감과 swap out을 함께 본다. |
| `host.memory_delta_bytes` | bytes | 이전 표본 대비 MemAvailable·SwapFree 변화다. 음수와 swap out의 동시 증가는 메모리 압력 신호다. |
| `host.swap_delta_pages` | pages | `/proc/vmstat`의 `pswpin`/`pswpout` delta다. page 크기를 추측해 byte로 바꾸지 않는다. |
| `host.disk_delta` | I/O 수·bytes·ms | 각 block device counter delta다. dm 장치와 물리 장치를 합산하면 이중 계산될 수 있어 device별로 본다. |
| `host.psi.*.full` | %/microseconds | 모든 runnable task가 해당 자원을 기다린 시간. `io.full.avg10`이 지속적으로 높으면 전역 I/O 병목 신호다. |
| `cgroup.memory_current/high/max` | bytes 또는 `max` | 서비스의 현재·throttle·hard cap이다. 현재 운영 기준은 high 512MiB, max 640MiB다. |
| `cgroup.memory_events` | 누적 횟수 | `high`, `max`, `oom`, `oom_kill` 증가를 이전 표본과 비교한다. |
| `cgroup.cpu_stat`, `cgroup.io_stat` | kernel 원문 counter | cgroup 단위 CPU throttling과 device별 I/O를 host 표본과 대조한다. |

장치별 평균 I/O 지연은 `(read_time_ms + write_time_ms) / (read_ios + write_ios)`로
계산한다. 분모가 0인 표본은 건너뛴다. `io_ms / measurement_window_ms × 100`은
장치가 I/O를 처리한 시간 비율이며, 병렬 장치의 실제 성능 상한과 같은 뜻은 아니다.

`host.psi.io.full` 상승, 낮은 CPU 사용률, disk `io_ms` 상승, 앱 요청 공백이 같은 15초
window에 겹치면 디스크 지연 가설이 강해진다. 반대로 `memory.events.oom` 또는 swap delta가
증가하면 메모리 압력을 우선 조사한다. 한 표본만으로 원인을 확정하지 않는다.

## journald 조회와 앱 로그 상관관계

host 표본만 보려면 다음을 사용한다.

```bash
journalctl -u quant-host-sample.service --since '2026-09-23 18:40:00 UTC' --until '2026-09-23 19:40:00 UTC' -o cat \
  | jq -R -c 'fromjson? | select(.event == "quant.host_sample")'
```

앱의 request/event-loop 로그와 같은 시간창을 나란히 본다.

```bash
journalctl -u quant-platform.service --since '2026-09-23 18:40:00 UTC' --until '2026-09-23 19:40:00 UTC' -o cat \
  | jq -R -c 'fromjson? | select(.event == "http.request.slow" or .event == "http.request.aborted" or .event == "runtime.event_loop_lag")'
```

응답이 전혀 없었던 window도 host timer 표본은 남는다. 이 차이가 앱 내부 Pino 로그만으로
판별할 수 없는 event-loop 정지와 호스트 I/O 압력을 구분하는 이유다.

## 보존 제한

sampler는 journald에 표본을 보낼 뿐 별도 로그 파일을 만들지 않는다. 보존은 시스템의
journald quota와 운영 보존 정책을 따른다. 전역 journal을 비우는 `journalctl --vacuum-*`는
다른 서비스 로그에도 영향을 주므로, 용량 정책 승인을 받은 뒤에만 사용한다.

909MiB 호스트의 보수적인 **예시**는 `/etc/systemd/journald.conf.d/quant-platform-diagnostics.conf`에
`SystemMaxUse=256M`, `SystemKeepFree=512M`, `MaxRetentionSec=14day`를 두는 것이다. 이 값들은
`quant-host-sample`만이 아니라 호스트의 모든 journal에 적용되므로, 설치 전에 sshd·시스템 로그
보존 요구와 함께 검토하고 `sudo systemctl restart systemd-journald`로 반영한다.
