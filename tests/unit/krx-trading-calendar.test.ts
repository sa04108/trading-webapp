import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { createOfficialKrxTradingCalendar, type KrxTradingCalendar } from '../../src/server/modules/market-data/infrastructure/krx/krx-trading-calendar.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { SqliteKrxRawSnapshotStore } from '../../src/server/modules/market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js';
import { SqliteProviderRequestPolicy } from '../../src/server/shared/provider-request-policy.js';
import type { Logger } from '../../src/server/shared/logger.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const calendar = createOfficialKrxTradingCalendar();

describe('KRX 공식 거래일 달력', () => {
  it('공식 휴장일 원문과 주말 규칙을 쓰고 미확보 연도는 UNKNOWN으로 남긴다', () => {
    expect(calendar.classify('2026-07-17', 'KOSPI').state).toBe('CLOSED');
    expect(calendar.classify('2026-06-03', 'KOSDAQ').state).toBe('CLOSED');
    expect(calendar.classify('2026-09-20', 'KOSPI').state).toBe('CLOSED');
    expect(calendar.classify('2026-09-21', 'KOSPI').state).toBe('OPEN');
    expect(calendar.classify('2016-02-09', 'KOSDAQ').state).toBe('CLOSED');
    expect(calendar.classify('2015-01-02', 'KOSPI').state).toBe('UNKNOWN');
    expect(calendar.classify('2027-01-04', 'KOSPI').state).toBe('UNKNOWN');
    expect(calendar.classify('2026-09-21', 'KOSPI').evidence).toContain('sha256=');
  });

  it.each(['OPEN', 'UNKNOWN'] as const)('%s의 빈 응답은 원문만 보존하고 재시작 뒤에도 HTTP 없이 게시 대기한다', async (state) => {
    const database = openDatabase(':memory:');
    try {
      const rawSnapshotStore = new SqliteKrxRawSnapshotStore(database.db);
      const requestPolicy = new SqliteProviderRequestPolicy(database.sqlite, () => 1);
      const tradingCalendar: KrxTradingCalendar = { classify: () => ({ state, evidence: '공식 달력 fixture' }) };
      const http = vi.fn(async () => new Response(JSON.stringify({ OutBlock_1: [] })));
      const source = () => createKrxHistoricalUniverseSource({ baseUrl: 'https://krx.test', apiKey: 'fake', approvalExpiry: null },
        { now: () => 1 }, logger, { rawSnapshotStore, requestPolicy, tradingCalendar, fetchImpl: http, sleep: async () => undefined });
      await expect(source().fetchDailyTrades('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      await expect(source().fetchDailyTrades('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      expect(http).toHaveBeenCalledTimes(1);
      expect(rawSnapshotStore.get({ namespace: 'https://krx.test', endpoint: '/svc/apis/sto/stk_bydd_trd', basDd: '20260921' })?.payload).toEqual({ OutBlock_1: [] });
      const plans = requestPolicy.list() as { fingerprint: string; status: string }[];
      const blocked = plans.find((plan) => plan.status === 'BLOCKED')!;
      expect(blocked).toBeDefined();
      requestPolicy.decide(blocked.fingerprint, true);
      await expect(source().fetchDailyTrades('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      await expect(source().fetchDailyTrades('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      expect(http).toHaveBeenCalledTimes(2);
    } finally { database.close(); }
  });

  it('공식 휴장일 빈 응답은 확정 무자료로 재사용한다', async () => {
    const database = openDatabase(':memory:');
    try {
      const http = vi.fn(async () => new Response(JSON.stringify({ OutBlock_1: [] })));
      const source = createKrxHistoricalUniverseSource({ baseUrl: 'https://krx.test', apiKey: 'fake', approvalExpiry: null },
        { now: () => 1 }, logger, { rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db), tradingCalendar: calendar, fetchImpl: http });
      await expect(source.fetchDailyTrades('KOSPI', '2026-07-17')).resolves.toEqual([]);
      await expect(source.fetchDailyTrades('KOSPI', '2026-07-17')).resolves.toEqual([]);
      expect(http).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });

  it('거래일의 빈 지수 응답은 확정 무자료로 오인하지 않는다', async () => {
    const database = openDatabase(':memory:');
    try {
      const http = vi.fn(async () => new Response(JSON.stringify({ OutBlock_1: [] })));
      const source = createKrxHistoricalUniverseSource({ baseUrl: 'https://krx.test', apiKey: 'fake', approvalExpiry: null },
        { now: () => 1 }, logger, { rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db), tradingCalendar: calendar, fetchImpl: http });
      await expect(source.fetchBenchmarkClose!('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      await expect(source.fetchBenchmarkClose!('KOSPI', '2026-09-21')).rejects.toThrow('PENDING_PUBLICATION');
      expect(http).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });
});
