# 알림 센터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 헤더 알림 버튼 + 알림 페이지. 백테스트·데이터 동기화 종료를 DB 에 저장하고 SSE 로 배지를 실시간 갱신한다.

**Architecture:** 전역 `notifications` 테이블 하나. `NotificationService` 가 insert 후 in-process EventEmitter 로 emit 하고, SSE 라우트가 그 이벤트를 구독한다. 생산자(백테스트 orchestrator, broker sync)는 notification 모듈을 import 하지 않는다 — container 가 클로저로 잇는다 (factsPhase 관례). 보관 기간은 기존 `pruneExpiredRows` 6시간 주기에 조건 하나를 추가한다.

**Tech Stack:** Fastify 5 + Drizzle(SQLite) + drizzle-kit migration / React 19 + TanStack Query v5 + shadcn/ui / vitest

**Spec:** `docs/superpowers/specs/2026-08-03-notification-center-design.md`

## Global Constraints

- 알림 소스는 두 가지뿐: 백테스트 job 종료 상태 도달, broker 데이터 동기화 job 종료. CSV import 는 제외한다 — 동기 요청이라 사용자가 응답으로 결과를 바로 받는다.
- 알림은 전역이다. user_id 없음, 읽음 플래그는 알림 행에 직접.
- 알림 생성 실패는 본 작업을 막지 않는다 — warn 로그만 남기고 삼킨다.
- market-data·backtest 모듈은 notification 모듈을 import 하지 않는다 (`tests/architecture/module-boundaries.test.ts` 가 감시). 연결은 container/bootstrap 에서만.
- SSE 는 `reply.hijack()` 필수 (`@fastify/compress` 전역 등록 때문) + `SECURITY_HEADERS` 수동 포함 + 15초 heartbeat — `backtest-routes.ts:562-611` 과 같은 방식.
- `NOTIFICATION_RETENTION_DAYS` 기본 7, `0` = 삭제 안 함 (`AUDIT_LOG_RETENTION_DAYS` 와 같은 규칙).
- 목록 상한 200건, 페이징 없음.
- 한국어 문서·주석 규칙 (CLAUDE.md): 문어체 평서형, 사용자 노출 문구만 합쇼체.
- 커밋은 한국어, 기존 스타일: `feat(notifications): …이다/…한다`.

---

### Task 1: notifications 테이블 + 보관 기간

**Files:**
- Modify: `src/server/shared/db/schema.ts` (auditLogs 다음, 57행 부근)
- Create: `migrations/0001_*.sql` (drizzle-kit 이 생성)
- Modify: `src/server/bootstrap/config.ts` (envSchema 29행 부근 + AppConfig + loadConfig 반환)
- Modify: `src/server/shared/db/maintenance.ts`
- Modify: `src/server/bootstrap/container.ts:114-118` (pruneOptions)
- Test: `tests/integration/maintenance.test.ts`

**Interfaces:**
- Produces: `notifications` 테이블 export (`schema.ts`), `AppConfig.notificationRetentionDays: number`, `PruneOptions.notificationRetentionMs: number`
- 이후 태스크가 쓰는 컬럼: `id text PK, type text, severity text, title text, body text|null, link text|null, read boolean, createdAtMs integer`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/integration/maintenance.test.ts` 수정. import 에 `notifications` 추가:

```ts
import { auditLogs, loginAttempts, notifications, sessions, users } from '../../src/server/shared/db/schema.js';
```

기존 두 테스트의 options 객체에 `notificationRetentionMs` 필드를 추가한다 (필수 필드가 되므로 컴파일이 잡는다):

- 첫 테스트(20행): `notificationRetentionMs: 7 * DAY`
- 둘째 테스트(77행 pruneExpiredRows 호출): `notificationRetentionMs: 0`

둘째 테스트에 보존 비활성 확인을 추가한다 — `db.insert(auditLogs)` 블록 다음에:

```ts
    db.insert(notifications)
      .values({
        id: 'ntf_ancient',
        type: 'backtest',
        severity: 'info',
        title: 'ancient',
        read: true,
        createdAtMs: now - 3650 * DAY,
      })
      .run();
```

그리고 마지막 expect 다음에:

```ts
    expect(db.select().from(notifications).all()).toHaveLength(1);
```

새 테스트를 describe 안에 추가:

```ts
  it('prunes notifications older than retention', () => {
    const db = ctx.container.database.db;
    const now = Date.now();

    db.insert(notifications)
      .values([
        {
          id: 'ntf_old',
          type: 'backtest',
          severity: 'info',
          title: 'old',
          read: true,
          createdAtMs: now - 8 * DAY,
        },
        {
          id: 'ntf_new',
          type: 'data-sync',
          severity: 'error',
          title: 'new',
          read: false,
          createdAtMs: now - DAY,
        },
      ])
      .run();

    pruneExpiredRows(db, now, {
      idleTimeoutMs: 12 * HOUR,
      absoluteTimeoutMs: 7 * DAY,
      auditLogRetentionMs: 0,
      notificationRetentionMs: 7 * DAY,
    });

    expect(db.select().from(notifications).all().map((n) => n.id)).toEqual(['ntf_new']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run tests/integration/maintenance.test.ts`
Expected: FAIL — `notifications` export 없음 (모듈 해석 오류 또는 타입 오류)

- [ ] **Step 3: 스키마 추가**

`src/server/shared/db/schema.ts` 의 `auditLogs` 정의 다음에 추가:

```ts
/**
 * 사용자 알림 (설계 2026-08-03-notification-center).
 * 전역이다 — backtest_jobs·data_sync_jobs 에 user_id 가 없는 것과 같은 이유로,
 * 이 시스템의 작업은 전부 전역 자원이고 읽음 플래그도 행에 직접 둔다.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'backtest' | 'data-sync'
    severity: text('severity').notNull(), // 'info' | 'error'
    title: text('title').notNull(),
    body: text('body'),
    /** 알림을 눌렀을 때 갈 곳. 대상이 삭제됐어도 남는다 — 404 가 출처 불명보다 낫다 */
    link: text('link'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_notifications_created').on(table.createdAtMs)],
);
```

- [ ] **Step 4: 마이그레이션 생성**

Run: `pnpm db:generate`
Expected: `migrations/0001_<이름>.sql` 생성, 내용에 `CREATE TABLE \`notifications\`` 와 `idx_notifications_created` 인덱스. `migrations/meta/_journal.json` 갱신 확인. 마이그레이션은 부팅 시 자동 적용된다 (`database.ts:56`) — 별도 적용 명령 없음.

- [ ] **Step 5: config 추가**

`src/server/bootstrap/config.ts`:

envSchema 의 `AUDIT_LOG_RETENTION_DAYS` 다음에:

```ts
  /** 알림 보존 일수 (설계 2026-08-03-notification-center). 0 = 삭제하지 않음 */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
```

`AppConfig` 의 `auditLogRetentionDays` 다음에:

```ts
  readonly notificationRetentionDays: number;
```

loadConfig 반환 객체의 `auditLogRetentionDays` 다음에:

```ts
    notificationRetentionDays: raw.NOTIFICATION_RETENTION_DAYS,
```

- [ ] **Step 6: maintenance 확장**

`src/server/shared/db/maintenance.ts`:

import 에 `notifications` 추가:

```ts
import { auditLogs, loginAttempts, notifications, sessions } from './schema.js';
```

`PruneOptions` 에 필드 추가:

```ts
  /** 알림 보존 기간. 0 이면 삭제하지 않는다 — audit 로그와 같은 규칙 */
  readonly notificationRetentionMs: number;
```

`pruneExpiredRows` 끝에 추가:

```ts
  if (options.notificationRetentionMs > 0) {
    db.delete(notifications)
      .where(lt(notifications.createdAtMs, nowMs - options.notificationRetentionMs))
      .run();
  }
```

- [ ] **Step 7: container pruneOptions 연결**

`src/server/bootstrap/container.ts` 의 pruneOptions (114행 부근) 에 추가:

```ts
    notificationRetentionMs: config.notificationRetentionDays * 86_400_000,
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm vitest run tests/integration/maintenance.test.ts tests/unit/config.test.ts`
Expected: PASS. `config.test.ts` 가 기본값을 통째로 단정하고 있어 깨지면 `notificationRetentionDays: 7` 기대값을 추가한다.

- [ ] **Step 9: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations src/server/bootstrap/config.ts src/server/shared/db/maintenance.ts src/server/bootstrap/container.ts tests/integration/maintenance.test.ts
git commit -m "feat(notifications): notifications 테이블과 7일 보관 정리를 추가한다"
```

---

### Task 2: NotificationService

**Files:**
- Create: `src/server/modules/notification/application/notification-service.ts`
- Modify: `src/server/bootstrap/container.ts` (생성 + Container 인터페이스 노출)
- Test: `tests/integration/notification-service.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `notifications` 테이블
- Produces (이후 태스크 전부가 이 시그니처에 의존):

```ts
export type NotificationType = 'backtest' | 'data-sync';
export type NotificationSeverity = 'info' | 'error';
export interface NotificationInput {
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | null;
  readonly link?: string | null;
}
export type NotificationRow = typeof notifications.$inferSelect;
class NotificationService {
  readonly events: EventEmitter; // 'notification' 이벤트, payload = NotificationRow
  create(input: NotificationInput): NotificationRow;
  list(): NotificationRow[]; // 최신순 최대 200
  unreadCount(): number;
  markAllRead(): void;
  remove(ids: readonly string[]): void;
  removeAll(): void;
}
```

- `container.notificationService: NotificationService`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `tests/integration/notification-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications } from '../../src/server/shared/db/schema.js';
import type { NotificationRow } from '../../src/server/modules/notification/application/notification-service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('NotificationService', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('creates a notification, persists it, and emits an event', () => {
    const service = ctx.container.notificationService;
    const emitted: NotificationRow[] = [];
    service.events.on('notification', (row: NotificationRow) => emitted.push(row));

    const row = service.create({
      type: 'backtest',
      severity: 'error',
      title: '백테스트가 실패했습니다',
      body: 'cross-sectional-momentum — 메모리 부족',
      link: '/backtests/bt_x',
    });

    expect(row.id).toMatch(/^ntf_/);
    expect(row.read).toBe(false);
    expect(emitted).toEqual([row]);
    expect(service.list()).toEqual([row]);
    expect(service.unreadCount()).toBe(1);
  });

  it('lists newest first with a 200-row cap', () => {
    const db = ctx.container.database.db;
    const base = Date.now();
    db.insert(notifications)
      .values(
        Array.from({ length: 205 }, (_, i) => ({
          id: `ntf_${String(i).padStart(3, '0')}`,
          type: 'backtest',
          severity: 'info' as const,
          title: `n${i}`,
          read: false,
          createdAtMs: base + i,
        })),
      )
      .run();

    const listed = ctx.container.notificationService.list();
    expect(listed).toHaveLength(200);
    expect(listed[0]?.id).toBe('ntf_204'); // 최신이 앞
    expect(listed[199]?.id).toBe('ntf_005'); // 가장 오래된 5건이 잘린다
  });

  it('marks all read and deletes by ids or all', () => {
    const service = ctx.container.notificationService;
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    const b = service.create({ type: 'data-sync', severity: 'info', title: 'b' });
    service.create({ type: 'data-sync', severity: 'info', title: 'c' });

    service.markAllRead();
    expect(service.unreadCount()).toBe(0);
    expect(service.list().every((n) => n.read)).toBe(true);

    service.remove([a.id, b.id]);
    expect(service.list().map((n) => n.title)).toEqual(['c']);

    service.remove([]); // 빈 배열은 no-op — inArray 에 빈 배열을 주면 drizzle 이 던진다
    expect(service.list()).toHaveLength(1);

    service.removeAll();
    expect(service.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run tests/integration/notification-service.test.ts`
Expected: FAIL — notification-service 모듈 없음 / `container.notificationService` 없음

- [ ] **Step 3: 서비스 구현**

Create `src/server/modules/notification/application/notification-service.ts`:

```ts
import { EventEmitter } from 'node:events';
import { count, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { notifications } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';

export type NotificationType = 'backtest' | 'data-sync';
export type NotificationSeverity = 'info' | 'error';

export interface NotificationInput {
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | null;
  readonly link?: string | null;
}

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * 목록 상한 (설계 2026-08-03-notification-center). 7일 보관에서 이 상한을 넘는 경우는
 * 드물고, 넘치면 오래된 것이 잘린다 — 페이징 대신 상한이다.
 */
const LIST_LIMIT = 200;

/**
 * 사용자 알림. 저장이 전달이다 — 접속 중이면 events 를 SSE 가 실어 나르고,
 * 미접속 중 발생분은 다음 접속 때 목록으로 본다.
 */
export class NotificationService {
  /** 'notification' 이벤트, payload = NotificationRow. SSE 라우트가 구독한다 */
  readonly events = new EventEmitter();

  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: NotificationInput): NotificationRow {
    const row: NotificationRow = {
      id: newId('ntf'),
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      read: false,
      createdAtMs: this.clock.now(),
    };
    this.db.insert(notifications).values(row).run();
    this.events.emit('notification', row);
    return row;
  }

  list(): NotificationRow[] {
    return this.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAtMs), desc(notifications.id))
      .limit(LIST_LIMIT)
      .all();
  }

  unreadCount(): number {
    const [row] = this.db
      .select({ value: count() })
      .from(notifications)
      .where(eq(notifications.read, false))
      .all();
    return row?.value ?? 0;
  }

  markAllRead(): void {
    this.db.update(notifications).set({ read: true }).where(eq(notifications.read, false)).run();
  }

  remove(ids: readonly string[]): void {
    if (ids.length === 0) return; // inArray 는 빈 배열에서 던진다
    this.db.delete(notifications).where(inArray(notifications.id, [...ids])).run();
  }

  removeAll(): void {
    this.db.delete(notifications).run();
  }
}
```

- [ ] **Step 4: container 등록**

`src/server/bootstrap/container.ts`:

import 추가 (audit-service import 근처):

```ts
import { NotificationService } from '../modules/notification/application/notification-service.js';
```

`Container` 인터페이스의 `auditLog` 다음에:

```ts
  readonly notificationService: NotificationService;
```

`createContainer` 에서 `const auditLog = …` 다음 줄에 생성:

```ts
  const notificationService = new NotificationService(database.db, clock);
```

반환 객체의 `auditLog,` 다음에 `notificationService,` 추가.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/integration/notification-service.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/notification tests/integration/notification-service.test.ts src/server/bootstrap/container.ts
git commit -m "feat(notifications): NotificationService 를 추가한다"
```

---

### Task 3: HTTP 라우트 + SSE

**Files:**
- Create: `src/server/modules/notification/presentation/notification-routes.ts`
- Modify: `src/server/bootstrap/server.ts` (import + register)
- Test: `tests/integration/notification-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `NotificationService`
- Produces (프론트가 의존하는 API 계약):
  - `GET /api/v1/notifications` → `{ notifications: NotificationRow[] }` (최신순 ≤200)
  - `GET /api/v1/notifications/unread-count` → `{ count: number }`
  - `POST /api/v1/notifications/read-all` → 204
  - `DELETE /api/v1/notifications` body `{ ids: string[] }` 또는 `{ all: true }` → 204, 빈 지정은 400
  - `GET /api/v1/notifications/events` → SSE, 새 알림마다 `data: <NotificationRow JSON>` 프레임
  - 전부 `requireAuth`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `tests/integration/notification-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

describe('notification routes', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('requires auth on every endpoint', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/notifications/unread-count'],
      ['POST', '/api/v1/notifications/read-all'],
      ['DELETE', '/api/v1/notifications'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, ...(method === 'DELETE' ? { payload: { all: true } } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lists newest first and counts unread', async () => {
    const base = Date.now();
    ctx.container.database.db
      .insert(notifications)
      .values([
        { id: 'ntf_a', type: 'backtest', severity: 'info', title: 'a', read: true, createdAtMs: base - 2 },
        { id: 'ntf_b', type: 'data-sync', severity: 'error', title: 'b', read: false, createdAtMs: base - 1 },
      ])
      .run();

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { notifications: Array<{ id: string; read: boolean }> };
    expect(body.notifications.map((n) => n.id)).toEqual(['ntf_b', 'ntf_a']);

    const countRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      cookies: { qp_session: cookie },
    });
    expect(countRes.json()).toEqual({ count: 1 });
  });

  it('marks all read', async () => {
    ctx.container.notificationService.create({ type: 'backtest', severity: 'info', title: 'x' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      cookies: { qp_session: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(ctx.container.notificationService.unreadCount()).toBe(0);
  });

  it('deletes by ids, deletes all, rejects empty selection', async () => {
    const service = ctx.container.notificationService;
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    service.create({ type: 'backtest', severity: 'info', title: 'b' });

    const byIds = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: { ids: [a.id] },
    });
    expect(byIds.statusCode).toBe(204);
    expect(service.list().map((n) => n.title)).toEqual(['b']);

    const empty = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const all = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/notifications',
      cookies: { qp_session: cookie },
      payload: { all: true },
    });
    expect(all.statusCode).toBe(204);
    expect(service.list()).toEqual([]);
  });
});
```

SSE 라우트는 inject 로 스트림을 열어 두기 어렵다 — push 자체는 Task 2 의 events emit 테스트가 덮고, 스트림 연결은 Task 7 수동 확인으로 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run tests/integration/notification-routes.test.ts`
Expected: FAIL — 404 (라우트 없음)

- [ ] **Step 3: 라우트 구현**

Create `src/server/modules/notification/presentation/notification-routes.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type {
  NotificationRow,
  NotificationService,
} from '../application/notification-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerNotificationRoutes(
  app: FastifyInstance,
  service: NotificationService,
  requireAuth: PreHandler,
): void {
  app.get('/notifications', { preHandler: requireAuth }, async () => ({
    notifications: service.list(),
  }));

  app.get('/notifications/unread-count', { preHandler: requireAuth }, async () => ({
    count: service.unreadCount(),
  }));

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (_request, reply) => {
    service.markAllRead();
    return reply.code(204).send();
  });

  app.delete('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as { ids?: unknown; all?: unknown } | null;
    if (body?.all === true) {
      service.removeAll();
      return reply.code(204).send();
    }
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((value): value is string => typeof value === 'string')
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: '삭제할 알림을 지정하세요' });
    service.remove(ids);
    return reply.code(204).send();
  });

  /**
   * 새 알림 SSE (설계 2026-08-03-notification-center). 백테스트 SSE 와 같은 방식 —
   * 연결이 끊기면 클라이언트는 unread-count 폴링으로 fallback 한다.
   */
  app.get('/notifications/events', { preHandler: requireAuth }, async (request, reply) => {
    reply.hijack();
    // hijack 은 onSend hook 을 우회하므로 §16 보안 헤더를 직접 포함한다
    reply.raw.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 첫 바이트를 즉시 보낸다 — 프록시·브라우저가 연결 수립을 확인할 수 있게
    reply.raw.write(':connected\n\n');

    const listener = (row: NotificationRow): void => {
      reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
    };
    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), 15_000);
    heartbeat.unref();

    service.events.on('notification', listener);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      service.events.off('notification', listener);
    });
  });
}
```

- [ ] **Step 4: server.ts 등록**

`src/server/bootstrap/server.ts`:

import 추가:

```ts
import { registerNotificationRoutes } from '../modules/notification/presentation/notification-routes.js';
```

`/api/v1` register 블록 안, `registerStrategyRoutes(...)` 다음에:

```ts
      registerNotificationRoutes(api, container.notificationService, requireAuth);
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/integration/notification-routes.test.ts tests/architecture/module-boundaries.test.ts`
Expected: PASS (module-boundaries 도 통과 — notification 모듈은 shared 만 import)

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/notification/presentation tests/integration/notification-routes.test.ts src/server/bootstrap/server.ts
git commit -m "feat(notifications): 알림 조회·읽음·삭제 API 와 SSE 스트림을 추가한다"
```

---

### Task 4: 생산자 연결 — 백테스트·데이터 동기화

**Files:**
- Create: `src/server/bootstrap/notification-wiring.ts`
- Modify: `src/server/modules/market-data/application/broker-sync-service.ts` (BrokerSyncDeps + run 의 종료 지점 3곳)
- Modify: `src/server/bootstrap/container.ts` (safeNotify 클로저 + listener 구독 + brokerSync deps)
- Test: `tests/unit/notification-wiring.test.ts`, `tests/unit/broker-sync-service.test.ts` 확장

**Interfaces:**
- Consumes: `NotificationService.create`, `JobOrchestrator.events`(`JobEvent = { jobId, kind: 'progress' | 'status' }`), `JobQueue.getJob`
- Produces:
  - `createBacktestNotificationListener(deps: { queue: Pick<JobQueue, 'getJob'>; notify: (input: NotificationInput) => void; logger: Logger }): (event: JobEvent) => void`
  - `BrokerSyncDeps.notify?: (input: { severity: 'info' | 'error'; title: string; body: string; link: string }) => void` — type 은 container 가 `'data-sync'` 로 채운다 (market-data 가 notification 타입을 모르게)

- [ ] **Step 1: wiring 실패 테스트 작성**

Create `tests/unit/notification-wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBacktestNotificationListener } from '../../src/server/bootstrap/notification-wiring.js';
import type { NotificationInput } from '../../src/server/modules/notification/application/notification-service.js';
import type { BacktestJobRow } from '../../src/server/modules/backtest/application/job-queue.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function fakeJob(overrides: Partial<BacktestJobRow>): BacktestJobRow {
  return {
    id: 'bt_1',
    status: 'COMPLETED',
    strategyId: 'cross-sectional-momentum',
    error: null,
    ...overrides,
  } as BacktestJobRow;
}

function harness(job: BacktestJobRow | null) {
  const created: NotificationInput[] = [];
  const listener = createBacktestNotificationListener({
    queue: { getJob: () => job },
    notify: (input) => created.push(input),
    logger,
  });
  return { created, listener };
}

describe('createBacktestNotificationListener', () => {
  it('notifies on terminal status with a link to the job', () => {
    const { created, listener } = harness(fakeJob({ status: 'COMPLETED' }));
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'backtest',
      severity: 'info',
      link: '/backtests/bt_1',
    });
  });

  it('marks FAILED as error severity and includes the error message', () => {
    const { created, listener } = harness(
      fakeJob({ status: 'FAILED', error: '메모리 부족' }),
    );
    listener({ jobId: 'bt_1', kind: 'status' });

    expect(created[0]?.severity).toBe('error');
    expect(created[0]?.body).toContain('메모리 부족');
  });

  it('ignores progress events, non-terminal statuses, and missing jobs', () => {
    const running = harness(fakeJob({ status: 'RUNNING' }));
    running.listener({ jobId: 'bt_1', kind: 'status' });
    running.listener({ jobId: 'bt_1', kind: 'progress' });
    expect(running.created).toEqual([]);

    const gone = harness(null);
    gone.listener({ jobId: 'bt_1', kind: 'status' });
    expect(gone.created).toEqual([]);
  });

  it('swallows notify failures — the orchestrator must not throw', () => {
    const listener = createBacktestNotificationListener({
      queue: { getJob: () => fakeJob({ status: 'COMPLETED' }) },
      notify: () => {
        throw new Error('insert failed');
      },
      logger,
    });
    expect(() => listener({ jobId: 'bt_1', kind: 'status' })).not.toThrow();
  });
});
```

`BacktestJobRow` 가 `job-queue.js` 에서 export 되지 않으면 해당 타입의 실제 export 위치를 확인해 import 를 맞춘다 (`serializeJob` 이 쓰는 행 타입).

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run tests/unit/notification-wiring.test.ts`
Expected: FAIL — notification-wiring 모듈 없음

- [ ] **Step 3: wiring 구현**

Create `src/server/bootstrap/notification-wiring.ts`:

```ts
/**
 * 알림 생산자 연결 (설계 2026-08-03-notification-center).
 *
 * backtest 모듈이 notification 모듈을 import 하지 않도록 container 가 이 listener 를
 * orchestrator.events 에 건다 — facts-wiring 과 같은 관례로, 테스트가 겨눌 수 있는
 * 자리에 둔다.
 */
import type { JobEvent } from '../modules/backtest/application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../modules/backtest/application/job-queue.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import type { Logger } from '../shared/logger.js';

const TERMINAL_NOTIFICATIONS: Partial<
  Record<BacktestJobRow['status'], { title: string; severity: 'info' | 'error' }>
> = {
  COMPLETED: { title: '백테스트가 완료되었습니다', severity: 'info' },
  FAILED: { title: '백테스트가 실패했습니다', severity: 'error' },
  CANCELLED: { title: '백테스트가 취소되었습니다', severity: 'info' },
  INTERRUPTED: { title: '백테스트가 중단되었습니다', severity: 'error' },
};

export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, 'getJob'>;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void {
  return (event) => {
    if (event.kind !== 'status') return;
    // 알림 실패가 orchestrator 의 emit 경로를 끊으면 안 된다 — 삼키고 warn 만 남긴다
    try {
      const job = deps.queue.getJob(event.jobId);
      if (!job) return;
      const terminal = TERMINAL_NOTIFICATIONS[job.status];
      if (!terminal) return;
      deps.notify({
        type: 'backtest',
        severity: terminal.severity,
        title: terminal.title,
        body:
          job.status === 'FAILED' && job.error
            ? `${job.strategyId} — ${job.error}`
            : job.strategyId,
        link: `/backtests/${job.id}`,
      });
    } catch (error) {
      deps.logger.warn(
        { module: 'notification', event: 'notify.backtest.failed', jobId: event.jobId, err: error },
        'backtest notification failed',
      );
    }
  };
}
```

`BacktestJobRow['status']` 가 string 리터럴 유니온이 아니라 `string` 이면 `Partial<Record<string, …>>` 로 둔다.

- [ ] **Step 4: wiring 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/notification-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: broker sync 실패 테스트 확장**

`tests/unit/broker-sync-service.test.ts`:

`buildHarness` 의 options 에 notify 수집을 추가한다:

```ts
// options 타입에 추가할 것 없음 — harness 가 자체 수집한다
```

`buildHarness` 본문에서 `const sync = new BrokerSyncService({...})` 앞에:

```ts
  const notified: Array<{ severity: string; title: string; body: string; link: string }> = [];
```

deps 에 `notify: (input) => notified.push(input),` 추가, 반환 객체에 `notified` 추가.

describe 블록에 테스트 추가:

```ts
  it('notifies on sync completion and on failure', async () => {
    const ok = buildHarness(new FakeSource(minutes('005930', 10)));
    const { done } = ok.sync.startSync(ok.seed(['005930']), { slice: '1m' });
    await done;
    expect(ok.notified).toHaveLength(1);
    expect(ok.notified[0]).toMatchObject({ severity: 'info', link: '/datasets' });

    const failingSource: MarketDataSource = {
      fetchCandles: () => Promise.reject(new Error('API down')),
    };
    const bad = buildHarness(failingSource);
    const run = bad.sync.startSync(bad.seed(['005930']), { slice: '1m' });
    await run.done;
    expect(bad.notified).toHaveLength(1);
    expect(bad.notified[0]?.severity).toBe('error');
    expect(bad.notified[0]?.body).toContain('API down');
  });
```

(FakeSource·minutes·buildHarness 는 그 파일에 이미 있다. `MarketDataSource` 인터페이스에 메서드가 더 있으면 실패용 fake 를 그 형태에 맞춘다.)

- [ ] **Step 6: 실패 확인**

Run: `pnpm vitest run tests/unit/broker-sync-service.test.ts`
Expected: FAIL — `notify` 가 BrokerSyncDeps 에 없음 (타입 오류) 또는 notified 가 빈 배열

- [ ] **Step 7: BrokerSyncService 에 notify 추가**

`src/server/modules/market-data/application/broker-sync-service.ts`:

`BrokerSyncDeps` 에 추가 (factsPhase 다음):

```ts
  /**
   * 잡 종료 알림. market-data 는 notification 모듈을 import 하지 않는다 — container 가
   * 클로저로 잇는다 (factsPhase 와 같은 관례). 미주입이면 알림 없이 동작한다 (테스트 등).
   */
  readonly notify?: (input: {
    severity: 'info' | 'error';
    title: string;
    body: string;
    link: string;
  }) => void;
```

`run()` 성공 경로 — `factsStop` 으로 status 를 정해 update 하는 블록에서, status 계산을 변수로 빼고 update 후 notify (기존 audit.record 분기 근처):

```ts
      const finalStatus =
        factsStop === 'CANCELLED' ? 'CANCELLED' : factsStop === 'ERROR' ? 'FAILED' : 'COMPLETED';
```

(기존 `.set({ status: … })` 의 삼항식을 `finalStatus` 로 교체)

update `.run()` 직후에:

```ts
      this.deps.notify?.({
        severity: finalStatus === 'FAILED' ? 'error' : 'info',
        title:
          finalStatus === 'COMPLETED'
            ? '데이터 동기화가 완료되었습니다'
            : finalStatus === 'FAILED'
              ? '데이터 동기화가 실패했습니다'
              : '데이터 동기화가 취소되었습니다',
        body:
          `${targets.length}종목 · ${totalRows.toLocaleString('ko-KR')}행` +
          (facts?.state.failureMessage ? ` — ${facts.state.failureMessage}` : ''),
        link: '/datasets',
      });
```

`catch` 경로 — update `.run()` 직후, `if (cancelled)` 분기 **앞**에:

```ts
      this.deps.notify?.({
        severity: cancelled ? 'info' : 'error',
        title: cancelled ? '데이터 동기화가 취소되었습니다' : '데이터 동기화가 실패했습니다',
        body:
          `${targets.length}종목 — ` +
          (error instanceof Error ? error.message : String(error)),
        link: '/datasets',
      });
```

- [ ] **Step 8: container 연결**

`src/server/bootstrap/container.ts`:

import 추가:

```ts
import { createBacktestNotificationListener } from './notification-wiring.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
```

notificationService 생성 직후에 안전 래퍼:

```ts
  // 알림 생성 실패는 본 작업(백테스트·동기화)을 막지 않는다 — warn 만 남기고 삼킨다
  const safeNotify = (input: NotificationInput): void => {
    try {
      notificationService.create(input);
    } catch (error) {
      logger.warn(
        { module: 'notification', event: 'notify.failed', err: error },
        'notification create failed',
      );
    }
  };
```

`brokerSyncService` 생성 deps 에 추가:

```ts
    notify: (input) => safeNotify({ type: 'data-sync', ...input }),
```

`jobOrchestrator` 생성 직후에:

```ts
  jobOrchestrator.events.on(
    'job',
    createBacktestNotificationListener({ queue: jobQueue, notify: safeNotify, logger }),
  );
```

- [ ] **Step 9: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/broker-sync-service.test.ts tests/unit/notification-wiring.test.ts tests/architecture/module-boundaries.test.ts`
Expected: PASS

- [ ] **Step 10: 커밋**

```bash
git add src/server/bootstrap/notification-wiring.ts src/server/bootstrap/container.ts src/server/modules/market-data/application/broker-sync-service.ts tests/unit/notification-wiring.test.ts tests/unit/broker-sync-service.test.ts
git commit -m "feat(notifications): 백테스트·데이터 동기화 종료를 알림으로 만든다"
```

---

### Task 5: 알림 페이지 (웹)

**Files:**
- Create: `src/web/features/notifications/types.ts`
- Create: `src/web/features/notifications/api.ts`
- Create: `src/web/features/notifications/notifications-page.tsx`
- Modify: `src/web/app/router.tsx`

**Interfaces:**
- Consumes: Task 3 의 API 계약
- Produces: `NotificationsPage`, `useNotifications()`, `useUnreadCount(pollingFallback)`, `useNotificationStream()` — Task 6 의 벨이 뒤 둘을 쓴다. 쿼리 키: 목록 `['notifications','list']`, 카운트 `['notifications','unread-count']`, SSE invalidate 는 prefix `['notifications']`.

- [ ] **Step 1: 타입·API 모듈 작성**

Create `src/web/features/notifications/types.ts`:

```ts
export type NotificationSeverity = 'info' | 'error';

export interface NotificationItem {
  id: string;
  type: 'backtest' | 'data-sync';
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAtMs: number;
}
```

Create `src/web/features/notifications/api.ts`:

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { NotificationItem } from './types';

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => api<{ notifications: NotificationItem[] }>('/notifications'),
  });
}

export function useUnreadCount(pollingFallback: boolean) {
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    // SSE 가 죽었을 때만 폴링 — 평소에는 push 가 invalidate 한다
    refetchInterval: pollingFallback ? 60_000 : false,
  });
}

/**
 * 전역 알림 SSE (스펙 §14 의 backtest SSE 와 같은 패턴). shell 에서 한 번만 구독한다.
 * 연결이 실패하면 true 를 돌려 호출부가 unread-count 폴링으로 내려앉는다.
 */
export function useNotificationStream(): boolean {
  const queryClient = useQueryClient();
  const [sseFailed, setSseFailed] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (sourceRef.current || sseFailed) return;
    const source = new EventSource('/api/v1/notifications/events');
    sourceRef.current = source;
    source.onmessage = () => {
      // 내용은 쓰지 않는다 — 목록·카운트 쿼리를 무효화하면 화면이 알아서 당겨 온다
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setSseFailed(true); // polling fallback 활성화
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [sseFailed, queryClient]);

  return sseFailed;
}
```

- [ ] **Step 2: 페이지 작성**

Create `src/web/features/notifications/notifications-page.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNotifications } from './api';
import type { NotificationItem } from './types';

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useNotifications();
  const notifications = data?.notifications ?? [];

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // 진입 시 전체 읽음. 목록 키는 무효화하지 않는다 — 지금 화면의 read=false 는
  // "이번에 새로 온 것" 강조로 쓰이는데, 목록을 다시 받으면 전부 읽음이 돼 사라진다.
  useEffect(() => {
    void api('/notifications/read-all', { method: 'POST' }).then(
      () => queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] }),
      () => {}, // 읽음 처리 실패는 치명적이지 않다 — 다음 진입에 다시 시도된다
    );
  }, [queryClient]);

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      api('/notifications', { method: 'DELETE', body: JSON.stringify({ ids }) }),
    onSuccess: () => {
      setSelected(new Set());
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.error(error.message),
  });

  const allSelected = notifications.length > 0 && selected.size === notifications.length;

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(notifications.map((n) => n.id)));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openItem = (item: NotificationItem) => {
    if (editing) {
      toggleOne(item.id);
      return;
    }
    if (item.link) void navigate(item.link);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>알림</CardTitle>
        <div className="flex items-center gap-2">
          {editing && (
            <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="전체 선택" />
                전체 선택
              </label>
              <Button
                variant="destructive"
                size="sm"
                disabled={selected.size === 0 || remove.isPending}
                onClick={() => remove.mutate([...selected])}
              >
                삭제 ({selected.size})
              </Button>
            </>
          )}
          {notifications.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing((prev) => !prev);
                setSelected(new Set());
              }}
            >
              {editing ? '완료' : '편집'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">불러오는 중…</p>
        ) : notifications.length === 0 ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">알림이 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {notifications.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-start gap-3 px-6 py-3 text-left transition-colors hover:bg-muted/50',
                    !item.read && 'bg-accent/40',
                    !editing && !item.link && 'cursor-default',
                  )}
                  onClick={() => openItem(item)}
                >
                  {editing && (
                    <Checkbox
                      checked={selected.has(item.id)}
                      onCheckedChange={() => toggleOne(item.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`${item.title} 선택`}
                      className="mt-0.5"
                    />
                  )}
                  {item.severity === 'error' ? (
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-loss" />
                  ) : (
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.title}</span>
                    {item.body && (
                      <span className="block truncate text-sm text-muted-foreground">
                        {item.body}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(item.createdAtMs, Date.now())}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

`text-loss` 클래스는 `pnlClass`(`format.ts:110`) 가 이미 쓰는 프로젝트 색이다. 없다고 나오면 `text-destructive` 로 바꾼다.

- [ ] **Step 3: 라우터 등록**

`src/web/app/router.tsx`:

import 추가:

```ts
import { NotificationsPage } from '../features/notifications/notifications-page';
```

children 배열의 `{ path: 'settings', … }` 앞에:

```ts
          { path: 'notifications', element: <NotificationsPage /> },
```

- [ ] **Step 4: 타입·린트 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/notifications src/web/app/router.tsx
git commit -m "feat(notifications): 알림 페이지를 추가한다 — 편집·개별선택·전체선택·삭제"
```

---

### Task 6: 헤더 알림 버튼 + SSE 구독

**Files:**
- Modify: `src/web/app/shell.tsx`

**Interfaces:**
- Consumes: Task 5 의 `useUnreadCount`, `useNotificationStream`

- [ ] **Step 1: 벨 컴포넌트 추가**

`src/web/app/shell.tsx`:

import 수정 — lucide 에 `Bell` 추가:

```ts
import { Bell, Database, FlaskConical, LayoutDashboard, LogOut, Moon, Settings, Sun } from 'lucide-react';
```

알림 훅 import 추가:

```ts
import { useNotificationStream, useUnreadCount } from '../features/notifications/api';
```

`ThemeToggle` 위에 컴포넌트 추가:

```tsx
function NotificationBell() {
  const navigate = useNavigate();
  // SSE 구독은 여기(shell 상주 컴포넌트) 한 곳이다 — 어느 페이지에 있든 배지가 갱신된다
  const sseFailed = useNotificationStream();
  const { data } = useUnreadCount(sseFailed);
  const count = data?.count ?? 0;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={count > 0 ? `알림 ${count}건` : '알림'}
      onClick={() => void navigate('/notifications')}
    >
      <Bell className="size-5" />
      {count > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Button>
  );
}
```

헤더의 버튼 묶음(121행 부근)에 삽입 — ThemeToggle 왼쪽:

```tsx
          <div className="ml-auto flex items-center">
            <NotificationBell />
            <ThemeToggle />
            <LogoutButton />
          </div>
```

`NAV_ITEMS` 와 `BottomNav` 는 건드리지 않는다 (진입점은 헤더 버튼 하나, `grid-cols-4` 유지).

- [ ] **Step 2: 타입·린트 확인**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src/web/app/shell.tsx
git commit -m "feat(notifications): 헤더에 알림 버튼과 안읽음 배지를 단다"
```

---

### Task 7: 전체 검증 + 수동 확인

**Files:** 없음 (검증만)

- [ ] **Step 1: 전체 자동 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS. 실패 시 원인을 고치고 해당 태스크 커밋에 이어 fix 커밋.

- [ ] **Step 2: 빌드**

Run: `pnpm build`
Expected: 서버·웹 빌드 성공

- [ ] **Step 3: 수동 확인 (SSE 는 자동 테스트가 못 덮는다)**

`pnpm dev` + `pnpm dev:web` 로 띄우고:

1. 로그인 → 헤더에 벨 아이콘 확인, 개발자 도구 Network 에 `/api/v1/notifications/events` 가 pending(스트림) 상태인지 확인.
2. 작은 백테스트 하나 실행 → 완료 시 다른 페이지에 있어도 배지 숫자가 몇 초 안에 오르는지 확인.
3. 벨 클릭 → 알림 페이지 이동, 방금 알림이 강조(bg-accent) 상태로 보이고 배지가 0 이 되는지 확인.
4. 알림 클릭 → 해당 백테스트 상세로 이동 확인.
5. 편집 → 개별 선택·전체 선택 → 삭제 동작 확인.
6. 서버 프로세스를 재시작하고(SSE 강제 단절) 배지가 60초 폴링으로 계속 갱신되는지 확인.

- [ ] **Step 4: 완료 보고**

수동 확인 결과를 사용자에게 보고하고, superpowers:finishing-a-development-branch 로 넘어간다.
