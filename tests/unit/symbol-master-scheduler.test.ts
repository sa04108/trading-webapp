import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../src/server/shared/clock.js';
import type { Logger } from '../../src/server/shared/logger.js';
import { SymbolMasterScheduler } from '../../src/server/modules/market-data/application/symbol-master-scheduler.js';
import type { SymbolMasterBackfill } from '../../src/server/modules/market-data/application/symbol-master-backfill.js';
import type { SymbolMasterService } from '../../src/server/modules/market-data/application/symbol-master-service.js';

class MutableClock implements Clock {
  constructor(private value: number) {}
  now(): number {
    return this.value;
  }
  set(value: number): void {
    this.value = value;
  }
}

/** KST 시각 생성 헬퍼 */
function kstTimeMs(isoDate: string, hour: number): number {
  // KST 오프셋: UTC+9 = 540분 = 32400초
  // KST hour를 UTC로 변환: UTC시각 = KST시각 - 9시간
  // 예: KST 18:00 = UTC 09:00
  const utcHour = hour - 9;
  return Date.parse(`${isoDate}T${String(utcHour).padStart(2, '0')}:00:00Z`);
}

describe('SymbolMasterScheduler', () => {
  it('KST 17:00 이전이면 아무것도 하지 않는다 (no-op)', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 17));
    const ingestDate = vi.fn();
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-08', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // service.ingestDate 가 호출되지 않았는지 확인
    expect(ingestDate).not.toHaveBeenCalled();
  });

  it('KST 18:00 이후이고 갭이 있으면 ingestDate를 순차 호출한다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn().mockResolvedValue({ kind: 'TRADING_DAY' });
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-08', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // 마지막 커버일(2024-01-08) 다음날(2024-01-09)부터 어제(2024-01-09)까지 ingest 호출
    expect(ingestDate).toHaveBeenCalledWith('2024-01-09');
    expect(ingestDate).toHaveBeenCalledTimes(1);
  });

  it('마지막 커버일이 3일 이상 이전이면 갭을 보정하여 순차 ingest 한다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-15', 19));
    const ingestDate = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'TRADING_DAY' })
      .mockResolvedValueOnce({ kind: 'TRADING_DAY' })
      .mockResolvedValueOnce({ kind: 'TRADING_DAY' });

    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-10', endDate: '2024-01-10' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // 어제(2024-01-14) 다음날인 2024-01-11부터 어제까지 순차 호출
    expect(ingestDate).toHaveBeenNthCalledWith(1, '2024-01-11');
    expect(ingestDate).toHaveBeenNthCalledWith(2, '2024-01-12');
    expect(ingestDate).toHaveBeenNthCalledWith(3, '2024-01-13');
  });

  it('마지막 커버일이 어제(KST)이면 no-op이며 멱등이다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn();
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-09', endDate: '2024-01-09' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    // 첫 번째 tick
    await scheduler.tick();
    expect(ingestDate).not.toHaveBeenCalled();

    // 두 번째 tick — 멱등 확인
    await scheduler.tick();
    expect(ingestDate).not.toHaveBeenCalled();
  });

  it('백필이 BUDGET_EXHAUSTED면 targetStartDate로 재개한다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn().mockResolvedValue({ kind: 'TRADING_DAY' });
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-05', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const start = vi.fn();
    const status = vi.fn().mockReturnValue({
      state: 'BUDGET_EXHAUSTED',
      cursorDate: '2024-01-09',
      targetStartDate: '2024-01-09',
      error: null,
    });
    const backfill = { start, status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // targetStartDate로 backfill.start 재호출
    expect(start).toHaveBeenCalledWith('2024-01-09');
  });

  it('ingest 중 오류가 발생하면 warn 로그 후 tick을 종료한다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn().mockRejectedValueOnce(new Error('API 오류'));
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-08', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const warn = vi.fn();
    const logger = { warn, error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // warn 로그가 호출되었는지 확인
    expect(warn).toHaveBeenCalled();
    // 첫 번째 인자는 객체, 두 번째는 메시지 문자열
    const [firstArg, secondArg] = warn.mock.calls[0] as [object, string];
    expect(firstArg).toHaveProperty('error', 'API 오류');
    expect(secondArg).toMatch(/종목 마스터 일일 동기화/);
  });

  it('coverage 가 빈 배열(최초 수집 전)이면 ingestDate를 호출하지 않는다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn();
    const coverageRanges = vi.fn().mockReturnValue([]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // coverage 가 비어 있으면 ingestDate 미호출
    expect(ingestDate).not.toHaveBeenCalled();
  });

  it('백필이 RUNNING 중이면 스케줄러의 갭 채움 루프를 건너뛴다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn();
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-08', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const start = vi.fn();
    const status = vi.fn().mockReturnValue({
      state: 'RUNNING',
      cursorDate: '2024-01-09',
      targetStartDate: '2024-01-08',
      error: null,
    });
    const backfill = { start, status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    await scheduler.tick();

    // 백필이 RUNNING 중이므로 스케줄러는 ingestDate 미호출
    expect(ingestDate).not.toHaveBeenCalled();
    // 백필 start() 도 호출되지 않음 (RUNNING 중이므로 BUDGET_EXHAUSTED 가 아님)
    expect(start).not.toHaveBeenCalled();
  });

  it('여러 번 tick 호출 시 중복 처리를 방지한다', async () => {
    const clock = new MutableClock(kstTimeMs('2024-01-10', 19));
    const ingestDate = vi.fn().mockImplementation(async () => {
      // 느린 ingestDate 시뮬레이션
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { kind: 'TRADING_DAY' };
    });
    const coverageRanges = vi.fn().mockReturnValue([
      { startDate: '2024-01-08', endDate: '2024-01-08' },
    ]);
    const service = {
      ingestDate,
      coverageRanges,
    } as unknown as SymbolMasterService;

    const status = vi.fn().mockReturnValue({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: null,
      error: null,
    });
    const backfill = { status } as unknown as SymbolMasterBackfill;
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    const scheduler = new SymbolMasterScheduler({
      service,
      backfill,
      clock,
      logger,
    });

    // tick 을 동시에 여러 번 호출
    await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
      scheduler.tick(),
    ]);

    // 첫 번째 tick 만 실행되고 나머지는 차단됨
    expect(ingestDate).toHaveBeenCalledTimes(1);
  });
});
