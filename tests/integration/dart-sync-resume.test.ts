import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { SqliteCorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteFactRepository } from '../../src/server/modules/facts/infrastructure/sqlite-fact-repository.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols } from '../../src/server/shared/db/schema.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const START = Date.UTC(2026, 8, 12);
const REQUEST = {
  symbols: ['005930'], fromYear: 2016, toYear: 2017, consolidated: true, mode: 'INCREMENTAL' as const,
};

function setup(database: DatabaseHandle, now: number, corrected = false) {
  const calls: string[] = [];
  const clock = { now: () => now };
  const source = createDartFactSource({ baseUrl: 'https://dart.test', apiKey: 'test' }, LOGGER, {
    clock,
    rawSnapshots: new SqliteDartRawSnapshotStore(database.db),
    corpCodeResolver: { resolve: async () => '00126380' },
    sleep: async () => {},
    fetchImpl: (async (url: string | URL) => {
      const parsed = new URL(String(url));
      const year = parsed.searchParams.get('bsns_year');
      const report = parsed.searchParams.get('reprt_code');
      calls.push(`${parsed.pathname}:${year}:${report}`);
      if (parsed.pathname.endsWith('/list.json')) {
        return Response.json({ status: '000', total_page: 1, list: corrected ? [{
          stock_code: '005930', report_nm: '사업보고서 (2016.12)',
          rcept_no: '20260913000001', rcept_dt: '20260913',
        }] : [] });
      }
      if (parsed.pathname.includes('fnlttSinglAcntAll')) {
        return Response.json({ status: '000', list: [{
          rcept_no: corrected && year === '2016' ? '20260913000001' : `${year}0515000001`,
          reprt_code: report, bsns_year: year, sj_div: 'BS',
          account_id: 'ifrs-full_CurrentAssets', account_nm: '유동자산',
          thstrm_amount: corrected && year === '2016' ? '2000' : '1000',
        }] });
      }
      return Response.json({ status: '013', message: '조회된 데이터가 없습니다' });
    }) as typeof fetch,
  });
  const facts = new SqliteFactRepository(database.db);
  const coverage = new SqliteFactCoverageStore(database.db);
  const actions = new SqliteCorporateActionCoverageStore(database.db);
  return {
    calls, facts, coverage, actions,
    service: new FactSyncService(source, facts, LOGGER, { bumpVersion() {} }, clock, coverage, actions),
  };
}

function seed(database: DatabaseHandle): void {
  database.db.insert(symbols).values({ code: '005930', market: 'KR', name: '테스트', createdAtMs: START }).run();
}

describe('DART 수집 중단 후 SQLite 재개', () => {
  it.each([7, 20])('원문 %i건 저장 후 중단해도 다음 날 DB 재개는 받은 응답을 다시 호출하지 않는다', async (limit) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-resume-'));
    const databasePath = path.join(dir, 'app.sqlite');
    let database = openDatabase(databasePath);
    const baseline = openDatabase(':memory:');
    try {
      seed(database);
      seed(baseline);
      const first = setup(database, START);
      const stopped = await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= limit ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      expect(stopped.stopReason).toBe('DAILY_QUOTA');
      expect(first.calls).toHaveLength(limit);
      expect(first.coverage.getCoveredYears(['005930']).get('005930') ?? []).toEqual(limit === 7 ? [] : [2016]);
      // 새 연결과 새 어댑터로 프로세스 메모리 캐시가 없는 재시작을 재현한다.
      database.close();
      database = openDatabase(databasePath);
      const resumed = setup(database, START + 86_400_000);
      expect(resumed.service.planFinancialSync(['005930'], 2016, 2017).calls).toBe(28 - limit);
      const completed = await resumed.service.sync(REQUEST);
      expect(completed.stopReason).toBeNull();
      const resumedRawCalls = resumed.calls.filter((call) => !call.includes('/list.json'));
      expect(resumedRawCalls).toHaveLength(28 - limit);
      expect(resumedRawCalls.filter((call) => first.calls.includes(call))).toEqual([]);
      expect(resumed.coverage.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
      expect(resumed.actions.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
      const uninterrupted = setup(baseline, START);
      await uninterrupted.service.sync(REQUEST);
      expect(await resumed.facts.getFacts({ scope: 'SYMBOL' })).toEqual(
        await uninterrupted.facts.getFacts({ scope: 'SYMBOL' }),
      );
      expect(await resumed.facts.getFacts({ scope: 'SYMBOL' })).not.toHaveLength(0);
    } finally {
      database.close();
      baseline.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([7, 16])('자본변동 전용 수집도 원문 %i건에서 중단한 뒤 받은 응답을 재사용한다', async (limit) => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      const stopped = await first.service.syncCorporateActions(REQUEST, {
        beforeDartRequest: () => first.calls.length >= limit ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      expect(stopped.stopReason).toBe('DAILY_QUOTA');
      const resumed = setup(database, START + 86_400_000);
      expect(resumed.service.planCorporateActionSync(['005930'], 2016, 2017).calls).toBe(20 - limit);
      expect((await resumed.service.syncCorporateActions(REQUEST)).stopReason).toBeNull();
      const rawCalls = resumed.calls.filter((call) => !call.includes('/list.json'));
      expect(rawCalls).toHaveLength(20 - limit);
      expect(rawCalls.filter((call) => first.calls.includes(call))).toEqual([]);
      expect([...first.calls, ...resumed.calls].some((call) => call.includes('fnlttSinglAcntAll'))).toBe(false);
      expect(resumed.actions.getCoveredYears(['005930']).get('005930')).toEqual([2016, 2017]);
    } finally {
      database.close();
    }
  });

  it('최신성을 확인할 수 없는 90일 이전의 미완료 원문은 강제로 갱신한다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= 7 ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      const resumed = setup(database, START + 91 * 86_400_000);
      expect(resumed.service.planFinancialSync(['005930'], 2016, 2017).calls).toBe(28);
      expect((await resumed.service.sync(REQUEST)).stopReason).toBeNull();
      expect(resumed.calls).toHaveLength(28);
      expect(resumed.calls.filter((call) => first.calls.includes(call))).toHaveLength(7);
    } finally {
      database.close();
    }
  });

  it('재개 사이 새 정정공시가 생기면 완료 연도도 갱신하고 접수번호를 닫는다', async () => {
    const database = openDatabase(':memory:');
    try {
      seed(database);
      const first = setup(database, START);
      await first.service.sync(REQUEST, {
        beforeDartRequest: () => first.calls.length >= 20 ? 'PAUSE_DAILY_QUOTA' : 'CONTINUE',
      });
      const resumed = setup(database, START + 86_400_000, true);
      expect((await resumed.service.sync(REQUEST)).stopReason).toBeNull();
      expect(resumed.calls.some((call) => call.includes('fnlttSinglAcntAll.json:2016:'))).toBe(true);
      const facts = await resumed.facts.getFacts({ scope: 'SYMBOL' });
      expect(facts.filter((fact) => fact.periodKey.startsWith('2016')).every((fact) => fact.value === 2000)).toBe(true);
      expect(resumed.coverage.getProcessedFilingReceiptNos(['20260913000001']).size).toBe(1);
      const next = setup(database, START + 86_400_000, true);
      await next.service.sync(REQUEST);
      expect(next.calls.every((call) => call.includes('/list.json'))).toBe(true);
      const actions = setup(database, START + 86_400_000, true);
      await actions.service.syncCorporateActions(REQUEST);
      expect(actions.calls.every((call) => call.includes('/list.json'))).toBe(true);
    } finally {
      database.close();
    }
  });
});
