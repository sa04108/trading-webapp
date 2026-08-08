import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { corporateActionSyncJobs } from '../../src/server/shared/db/schema.js';
import { newId } from '../../src/server/shared/ids.js';
import { CorporateActionSyncOrchestrator } from '../../src/server/modules/facts/application/corporate-action-sync-orchestrator.js';
import type { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const CLOCK = { now: () => 1_700_000_000_000 };

/**
 * 이 테스트는 부팅 시 고아 행 정리만 본다.
 * `syncCorporateActions` 자체의 진행·취소 동작은 `corporate-action-sync.test.ts` 가
 * 이미 다룬다.
 */
function noopFactSync(): FactSyncService {
  return {
    syncCorporateActions: () =>
      Promise.resolve({
        savedFacts: 0,
        gaps: [],
        stoppedAtSymbol: null,
        stopReason: null,
        failureMessage: null,
      }),
  } as unknown as FactSyncService;
}

function insertOrphan(handle: ReturnType<typeof openDatabase>, status: 'QUEUED' | 'RUNNING'): string {
  const id = newId('cas');
  handle.db
    .insert(corporateActionSyncJobs)
    .values({
      id,
      status,
      symbolsJson: JSON.stringify(['005930']),
      fromYear: 2026,
      toYear: 2026,
      doneSymbols: 0,
      totalSymbols: 1,
      createdAtMs: 1,
    })
    .run();
  return id;
}

async function waitForTerminal(
  orchestrator: CorporateActionSyncOrchestrator,
  jobId: string,
): Promise<void> {
  const start = Date.now();
  while (!orchestrator.isTerminal(orchestrator.getJob(jobId)?.status ?? '')) {
    if (Date.now() - start > 2_000) throw new Error('waitForTerminal timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 리뷰 finding(2026-08-08), 2 라운드.
 * 1 라운드에서는 이 정리를 생성자에서 불렀다.
 * 그런데 `createContainer()` 는 서버뿐 아니라 모든 CLI 서브커맨드도 만들고,
 * 전부 같은 DB 를 쓴다.
 * 생성자에서 정리하면 서버가 잡을 돌리는 도중 CLI 를 한 번 실행하기만 해도
 * 그 `RUNNING` 잡이 조용히 죽는다.
 * 그래서 `recoverOrphaned()` 를 명시적 메서드로 빼고, `main.ts` 의 서버 부팅
 * 경로에서만 부르게 했다(`JobOrchestrator.recoverInterrupted` 와 같은 자리).
 */
describe('CorporateActionSyncOrchestrator.recoverOrphaned — 서버 부팅 경로 호출', () => {
  it('RUNNING 으로 멈춘 행을 FAILED 로 정리하고 새 잡을 받는다', async () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    // 생성자는 더 이상 아무것도 정리하지 않는다 — main.ts 가 하는 일을 여기서 흉내낸다.
    orchestrator.recoverOrphaned();

    const orphan = orchestrator.getJob(orphanId);
    expect(orphan?.status).toBe('FAILED');
    expect(orphan?.error).toContain('재시작');
    expect(orchestrator.hasActiveJob()).toBe(false);

    // 정리가 빠지면 hasActiveJob() 이 계속 참이라 아래는 null(409) 이 된다.
    const job = orchestrator.start({ symbols: ['000660'], fromYear: 2026, toYear: 2026 });
    expect(job).not.toBeNull();

    // db.close() 전에 뒤에서 도는 run() 이 끝나기를 기다린다 — 그러지 않으면
    // 닫힌 커넥션에 쓰려다 처리되지 않은 거부가 난다.
    await waitForTerminal(orchestrator, job!.id);

    handle.close();
  });

  it('QUEUED 로 멈춘 행도 정리 대상이다', () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'QUEUED');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    orchestrator.recoverOrphaned();

    expect(orchestrator.getJob(orphanId)?.status).toBe('FAILED');
    handle.close();
  });

  it('정리할 행이 없으면 아무 일도 하지 않는다', () => {
    const handle = openDatabase(':memory:');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    orchestrator.recoverOrphaned();

    expect(orchestrator.hasActiveJob()).toBe(false);
    handle.close();
  });
});

/**
 * 리뷰가 실증한 사고를 재현한다: 서버가 실제로 잡을 돌리는 도중 CLI 가 같은 DB 로
 * 컨테이너를 새로 만든다.
 * `createContainer()` 가 하는 일은 `new CorporateActionSyncOrchestrator(...)` 뿐이고,
 * CLI 는 `recoverOrphaned()` 를 부르지 않는다 — `main.ts` 만 부른다.
 * 그래서 생성자 자체는 아무 것도 정리해서는 안 된다.
 */
describe('CorporateActionSyncOrchestrator — CLI 컨테이너 생성이 실행 중인 잡을 건드리지 않는다', () => {
  it('두 번째 인스턴스를 만들어도 첫 번째의 RUNNING 잡은 살아남는다', async () => {
    const handle = openDatabase(':memory:');
    const server = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    const job = server.start({ symbols: ['005930'], fromYear: 2026, toYear: 2026 });
    expect(job).not.toBeNull();
    // start() 는 첫 await 전까지 동기로 실행되므로 이 시점에 이미 RUNNING 이다.
    expect(server.getJob(job!.id)?.status).toBe('RUNNING');

    // CLI 서브커맨드가 같은 DB 로 컨테이너를 새로 만드는 상황이다 — 생성만 하고
    // recoverOrphaned() 는 부르지 않는다(main.ts 만 그 메서드를 부른다).
    new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    // 회귀 지점: 이전 버전은 생성자에서 정리를 돌려 이 자리에서 FAILED 가 됐다.
    expect(server.getJob(job!.id)?.status).toBe('RUNNING');
    expect(server.hasActiveJob()).toBe(true);

    await waitForTerminal(server, job!.id);
    handle.close();
  });
});

/**
 * 취소 플래그는 이 프로세스 안의 `Map` 이고 `start()` 만 채운다.
 * `recoverOrphaned()` 를 부르지 않는 부팅 경로(`scripts/e2e-server.ts`,
 * `tests/helpers/test-app.ts`)가 남긴 `RUNNING` 행에는 그 플래그가 없다.
 * 그런 행에 취소를 걸어도 아무도 플래그를 보지 않으면 `hasActiveJob()` 이 참으로
 * 굳어 새 잡이 계속 409 가 된다.
 */
describe('CorporateActionSyncOrchestrator.cancel — 남의 프로세스가 남긴 잡', () => {
  it('플래그가 없는 잡이면 행을 직접 종료한다', () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    expect(orchestrator.cancel(orphanId)).toBe('CANCELLING');

    // 회귀 지점: 플래그만 세우고 끝내면 이 행이 영원히 `RUNNING` 으로 남는다.
    expect(orchestrator.getJob(orphanId)?.status).toBe('CANCELLED');
    expect(orchestrator.hasActiveJob()).toBe(false);
    handle.close();
  });

  it('행을 종료했으므로 곧바로 새 잡을 받는다', async () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    orchestrator.cancel(orphanId);
    const job = orchestrator.start({ symbols: ['000660'], fromYear: 2026, toYear: 2026 });

    expect(job).not.toBeNull();
    await waitForTerminal(orchestrator, job!.id);
    handle.close();
  });

  it('종료된 잡은 여전히 취소 대상이 아니다', () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    orchestrator.cancel(orphanId);

    expect(orchestrator.cancel(orphanId)).toBe('NOT_CANCELLABLE');
    handle.close();
  });

  it('없는 잡도 취소 대상이 아니다', () => {
    const handle = openDatabase(':memory:');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    expect(orchestrator.cancel('cas_nope')).toBe('NOT_CANCELLABLE');
    handle.close();
  });
});

describe('CorporateActionSyncOrchestrator.getActiveJob — 409 가 실어 보낼 잡', () => {
  it('도는 잡이 없으면 null 이다', () => {
    const handle = openDatabase(':memory:');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    expect(orchestrator.getActiveJob()).toBeNull();
    handle.close();
  });

  it('도는 잡이 있으면 그 행을 돌려준다 — 클라이언트가 이 id 로 다시 붙는다', () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

    expect(orchestrator.getActiveJob()?.id).toBe(orphanId);
    handle.close();
  });
});

describe('CorporateActionSyncOrchestrator.stop — 종료 중에는 더 쓰지 않는다', () => {
  it('stop() 뒤에 끝난 잡은 상태를 옮기지 않는다 — 다음 부팅이 거둔다', async () => {
    const handle = openDatabase(':memory:');
    // 첫 `await` 에서 멈춰 있다가 풀어주는 가짜 수집 — `stop()` 이 끼어들 틈을 만든다
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factSync = {
      syncCorporateActions: async () => {
        await gate;
        return { savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
      },
    } as never;
    const orchestrator = new CorporateActionSyncOrchestrator(handle, factSync, CLOCK, LOGGER);

    const job = orchestrator.start({ symbols: ['005930'], fromYear: 2026, toYear: 2026 });
    expect(orchestrator.getJob(job!.id)?.status).toBe('RUNNING');

    orchestrator.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 회귀 지점: 종료 중에 상태를 쓰면 이미 닫힌 DB 를 만날 수 있다.
    expect(orchestrator.getJob(job!.id)?.status).toBe('RUNNING');
    handle.close();
  });
});
