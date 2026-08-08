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

/**
 * 리뷰 finding(2026-08-08): 서버가 `RUNNING` 도중 죽으면 그 행이 영원히 `RUNNING`
 * 으로 남는다.
 * `hasActiveJob()` 이 계속 참이라 이후 모든 `POST` 가 409 로 막힌다 — 수동 DB
 * 수술 말고는 빠져나올 길이 없었다.
 * 이 오케스트레이터는 같은 서버 프로세스 안에서 잡을 돈다.
 * 그래서 새 인스턴스가 만들어졌다는 사실 자체가 "지금 실제로 돌고 있는 잡은
 * 없다" 는 뜻이다.
 * 생성 시점에 `QUEUED`·`RUNNING` 으로 남은 행은 전부 고아로 보고 정리한다.
 */
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

describe('CorporateActionSyncOrchestrator — 부팅 시 고아 잡 정리', () => {
  it('RUNNING 으로 멈춘 행을 FAILED 로 정리하고 새 잡을 받는다', async () => {
    const handle = openDatabase(':memory:');
    const orphanId = insertOrphan(handle, 'RUNNING');

    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);

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

    expect(orchestrator.getJob(orphanId)?.status).toBe('FAILED');
    handle.close();
  });

  it('정리할 행이 없으면 아무 일도 하지 않는다', () => {
    const handle = openDatabase(':memory:');
    const orchestrator = new CorporateActionSyncOrchestrator(handle, noopFactSync(), CLOCK, LOGGER);
    expect(orchestrator.hasActiveJob()).toBe(false);
    handle.close();
  });
});
