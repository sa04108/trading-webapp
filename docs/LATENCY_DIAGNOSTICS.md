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
없으면 해당 단계에서 정지했거나 프로세스가 종료됐을 가능성이 있다.

## 장애 시각 해석

장애 시각 전후의 앱 로그를 보려면 위 명령의 `--since`에 해당 기간을 지정한다.
새 진단 이벤트는 이 코드가 운영에 적용된 시점부터 남는다.

앱 이벤트 루프가 멈추면 새 앱 로그도 그동안 기록되지 않는다. 로그 공백만으로 메모리와
디스크 중 어느 자원이 원인인지 확정할 수 없으며, 이미 운영 중인 호스트 지표·커널 OOM
기록과 대조해야 한다. 해당 시각의 호스트 지표가 없다면 앱 로그만으로는 판별할 수 없다.

## 로그 보존

앱 진단 로그는 다른 앱 로그와 함께 기존 journald 보존 정책을 따른다. 전역 보존 설정이나
`journalctl --vacuum-*`는 다른 서비스 로그에도 영향을 주므로 이 변경에서는 수정하지 않는다.
