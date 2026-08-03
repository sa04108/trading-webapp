# 알림 센터 — 헤더 알림 버튼과 알림 페이지

## 왜

백테스트 완료·데이터 동기화 결과는 지금 두 경로로만 전달된다. 백테스트는 상세 페이지를
열고 있을 때만 SSE 로 진행 상황이 오고, 데이터 동기화는 해당 패널이 폴링을 돌리는 동안만
toast 가 뜬다. 화면을 떠나 있으면 결과는 어디에도 남지 않는다 — 작업이 끝났는지 알려면
목록 화면으로 돌아가 상태를 직접 확인해야 한다.

알림을 DB 에 저장하면 "전달됐던 것" 과 "전달되지 못했던 것" 의 구분이 사라진다. 접속 중이면
SSE 로 즉시 배지가 갱신되고, 미접속 중 발생분은 다음 접속 때 페이지에서 그대로 본다.

## 범위

알림으로 저장하는 이벤트는 두 가지다.

- 백테스트 job 이 종료 상태(COMPLETED / FAILED / CANCELLED / INTERRUPTED)에 도달했을 때
- 데이터 동기화 job 이 종료됐을 때 (성공 / 실패)

서버 오류 로그·보안 이벤트는 넣지 않는다. 전자는 노이즈가 되고, 후자는 audit_logs 가
이미 담당한다.

## 알림은 전역이다

backtest_jobs 와 data_sync_jobs 에는 user_id 가 없다 — 이 시스템의 작업은 전부 전역
자원이다. 알림도 전역으로 저장하고, 읽음 플래그도 알림 행에 직접 둔다. 계정별 읽음
상태를 나누려면 조인 테이블이 필요한데, 운영자 도구에서 그 비용을 치를 이유가 없다.

## 모델

```
notifications
  id             text  PK (ULID)
  type           text  'backtest' | 'data-sync'
  severity       text  'info' | 'error'
  title          text
  body           text
  link           text  nullable  (예: /backtests/01J...)
  read           integer  0 | 1
  created_at_ms  integer
```

`link` 는 알림을 눌렀을 때 갈 곳이다. 백테스트 알림은 해당 상세 페이지, 데이터 동기화
알림은 데이터 화면. 대상이 이미 삭제됐어도 링크는 남는다 — 이동 후 404 를 보는 것이
링크가 없어 어디서 났는지 모르는 것보다 낫다.

## 서버 구조

`src/server/modules/notification/` 모듈 하나.

- `notification-service.ts` — `create()`, `list()`, `markAllRead()`, `remove(ids | all)`,
  `unreadCount()`. `create()` 는 insert 후 자체 EventEmitter 로 emit 한다.
- `notification-routes.ts` — 전부 `requireAuth`:
  - `GET /notifications` — 최신순 최대 200건
  - `GET /notifications/unread-count`
  - `POST /notifications/read-all`
  - `DELETE /notifications` — body `{ ids: string[] }` 또는 `{ all: true }`
  - `GET /notifications/events` — SSE

**알림 생성 실패는 본 작업을 막지 않는다.** 백테스트가 멀쩡히 끝났는데 알림 insert 가
실패했다고 job 을 FAILED 로 만들 수는 없다. warn 로그만 남기고 삼킨다.

### 발생 지점

- 백테스트: job-orchestrator 의 종료 상태 전이 지점. 이미 `events.emit('job', ...)` 을
  부르는 그 자리에서 알림도 만든다.
- 데이터 동기화: sync job 을 종료 상태로 기록하는 지점.

### SSE

기존 백테스트 SSE(`backtest-routes.ts` 의 `/backtests/:id/events`)와 같은 방식으로 만든다.
`@fastify/compress` 가 전역이라 일반 스트림 응답은 버퍼링되므로 `reply.hijack()` 이
필수이고, hijack 은 onSend 훅을 우회하므로 `SECURITY_HEADERS` 를 손으로 다시 얹는다.
15초 heartbeat 도 같다. 새 알림이 오면 알림 객체 하나를 data 프레임으로 보낸다 — 클라이언트는
내용으로 배지를 올리고 목록 쿼리를 무효화한다.

## 보관 기간

`pruneExpiredRows`(`src/server/shared/db/maintenance.ts`)에 조건 하나를 추가한다.
audit_logs 삭제와 같은 자리, 같은 6시간 주기다. 설정은 `NOTIFICATION_RETENTION_DAYS`,
기본 7, `0` 이면 삭제하지 않는다 — `AUDIT_LOG_RETENTION_DAYS` 와 같은 규칙.

## 화면

### 헤더 버튼

`shell.tsx` 헤더 우측, ThemeToggle 왼쪽에 Bell 아이콘 버튼. 안 읽은 알림이 있으면 개수
배지를 단다. 누르면 `/notifications` 로 이동. 사이드바 NAV_ITEMS 에는 넣지 않는다 —
진입점은 헤더 버튼 하나다 (BottomNav 의 `grid-cols-4` 도 건드리지 않는다).

### SSE 구독 위치

shell 레벨이다. 어느 페이지에 있든 새 알림이 배지에 즉시 반영돼야 한다. EventSource 가
끊기면 60초 간격 unread-count 폴링으로 내려앉는다 — 백테스트 SSE 의 폴백 패턴과 같다.

### 알림 페이지

- 최신순 목록, 페이징 없음, 상한 200건. 7일 보관이므로 이 상한을 넘는 경우는 드물고,
  넘치면 오래된 것이 잘린다.
- 페이지 진입 시 `read-all` 을 호출한다. 개별 읽음 토글은 없다 — 배지의 목적은 "새 것이
  있다" 를 알리는 것이고, 목록을 봤으면 그 목적은 끝났다.
- 편집 모드: 「편집」 버튼으로 체크박스를 노출하고, 개별 선택·전체 선택·선택 삭제를
  제공한다. 편집 모드가 아닐 때 항목을 누르면 `link` 로 이동한다.
- 알림 행: severity 아이콘(info / error), 제목, 본문, 상대 시각.

## 하지 않은 것

- **페이징.** 7일 × 하루 수십 건 규모에서 200건 상한이면 충분하다. 필요해지면 기존
  `lib/pagination.ts` 패턴을 그대로 쓸 수 있다.
- **개별 읽음/안읽음 관리.** 배지 하나를 위한 상태에 UI·API 를 늘릴 이유가 없다.
- **브라우저 푸시(Notification API).** 탭이 닫혀 있을 때의 전달은 이번 범위 밖이다.
  DB 저장이 이미 유실을 막는다.
- **toast 와의 통합.** 기존 sonner toast 는 그대로 둔다. toast 는 "지금 이 화면에서의
  즉시 피드백", 알림은 "놓친 것의 기록" — 역할이 다르다.
