import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aggregateToHourly } from '../../src/server/modules/market-data/domain/aggregate.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { KR_SESSION } from '../../src/server/modules/market-data/domain/exchange-session.js';
import { symbolCoverage } from '../../src/server/shared/db/schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * 백테스트 1분봉 소비 (설계 2026-07-29-backtest-timeframe-design.md).
 * 요청의 timeframe 필드가 소비 봉을 결정한다 — 미지정은 기존 동작(데이터셋 timeframe).
 *
 * 유니버스는 이제 데이터셋이 아니라 유니버스 규칙이 정한다(스펙 2026-08-05). 005930 을
 * KOSPI, 000660 을 KOSDAQ 으로 마스터에 등록해 둔다 — markets 필터 하나로 두 종목을
 * 서로 배타적으로 골라낼 수 있어(옛 "데이터셋을 바꿔 낀다" 자리), 시총 순위를 신경 쓸
 * 필요가 없다.
 */

/** 이 파일이 쓰는 유일한 기간의 시작일 — range-breakout 은 rebalanceMonths 가 없어 리밸런스가 하나뿐이다 */
const MASTER_DATE = '2026-05-31';

function kospiRule(): BacktestRequest['universeRule'] {
  return { markets: ['KOSPI'], topN: 1, sortKey: 'MKTCAP' };
}

function kosdaqRule(): BacktestRequest['universeRule'] {
  return { markets: ['KOSDAQ'], topN: 1, sortKey: 'MKTCAP' };
}

/** 평일 1분봉 (KST 09:00~15:30 = UTC 00:00~06:30, 하루 390봉) — 돌파·급락 반복 */
function buildMinuteCandles(weekdays: number): Candle[] {
  const candles: Candle[] = [];
  let cursor = Date.UTC(2026, 5, 1); // 2026-06-01 (월)
  let dayCount = 0;
  let index = 0;

  while (dayCount < weekdays) {
    const dayOfWeek = new Date(cursor).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      for (let i = 0; i < 390; i += 1) {
        const phase = index % 240;
        const base = phase < 140 ? 60_000 + phase * 40 : 65_600 - (phase - 140) * 50;
        candles.push({
          symbol: '005930',
          market: 'KR',
          timeframe: '1m',
          tsMs: cursor + i * MINUTE,
          open: base,
          high: base + 120,
          low: base - 120,
          close: base + 60,
          volume: 10_000,
        });
        index += 1;
      }
      dayCount += 1;
    }
    cursor += DAY;
  }
  return candles;
}

function buildRequest(timeframe?: '1m' | '1h' | '1d'): BacktestRequest {
  return {
    strategyId: 'range-breakout',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    universeRule: kospiRule(),
    ...(timeframe !== undefined ? { timeframe } : {}),
    period: { from: '2026-05-31', to: '2026-06-27' },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps',
    },
    risk: { maxPositions: 5 },
    randomSeed: 42,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('백테스트 1분봉 소비', () => {
  let ctx: TestApp;
  let cookie: string;
  let minuteCandles: Candle[];
  let hourlyCandles: Candle[];

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    // 1m 수집이 만드는 상태를 재현: 로컬 종목 등록 + 1m 원본 + 1h 집계 파티션
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    seedSymbolMasterUniverse(ctx.container, [MASTER_DATE], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
      { standardCode: 'KR7000660001', shortCode: '000660', name: 'SK하이닉스', market: 'KOSDAQ', marketCapKrw: '400000000000000' },
    ]);
    minuteCandles = buildMinuteCandles(15);
    hourlyCandles = aggregateToHourly(minuteCandles, KR_SESSION);
    await ctx.container.candleRepository.saveCandles(minuteCandles);
    await ctx.container.candleRepository.saveCandles(hourlyCandles);
    await ctx.container.symbolService.refreshCoverage('005930', 'KR', '1m');
    ctx.container.symbolService.bumpVersion('005930', '1m', 'broker:seed', Date.now());
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function runToTerminal(payload: BacktestRequest): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;
    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);
    return jobId;
  }

  it('timeframe=1m 요청은 1분봉 전체를 소비한다', { timeout: 90_000 }, async () => {
    const jobId = await runToTerminal(buildRequest('1m'));
    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    // 1h 로 읽었다면 hourlyCandles.length(주당 35봉)가 된다 — 1m 소비의 증거
    expect(job.totalBars).toBe(minuteCandles.length);
  });

  it('timeframe 미지정은 기존 동작 그대로 데이터셋 timeframe(1h)을 소비한다', { timeout: 90_000 }, async () => {
    const jobId = await runToTerminal(buildRequest());
    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    expect(job.totalBars).toBe(hourlyCandles.length);
  });

  it('데이터셋이 제공하지 않는 timeframe 은 제출을 거부한다', async () => {
    // 1h 데이터셋에 1d 요청
    const wrongTf = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest('1d'),
    });
    expect(wrongTf.statusCode).toBe(400);
    // 1h 데이터셋의 슬라이스는 1m 뿐이다 — 1d 슬라이스 자체가 없다는 원인을 정확히 말해야 한다
    expect(JSON.stringify(wrongTf.json())).toContain('아직');
    expect(JSON.stringify(wrongTf.json())).toContain('1d');

    /**
     * 봉 보유는 이제 **종목**의 속성이다 (D-034) — "이 데이터셋은 1m 을 제공하지 않는다"
     * 라는 개념 자체가 없다. 그래서 일봉만 가진 **별도 종목**으로 검증한다: 그 종목을
     * 유니버스로 1m 을 요청하면 "아직 1m 데이터가 없다" 가 나와야 한다. markets:['KOSDAQ']
     * 로 000660 만 골라 데이터셋을 바꿔 끼우던 옛 자리를 대신한다.
     */
    await ctx.container.candleRepository.saveCandles(
      [0, 1, 2, 3, 4].map((i) => ({
        symbol: '000660',
        market: 'KR' as const,
        timeframe: '1d' as const,
        tsMs: Date.UTC(2026, 5, 1 + i),
        open: 60_000,
        high: 61_000,
        low: 59_000,
        close: 60_500,
        volume: 1_000_000,
      })),
    );
    await ctx.container.symbolService.refreshCoverage('000660', 'KR', '1d');
    ctx.container.symbolService.bumpVersion('000660', '1d', 'broker:seed', Date.now());

    const minuteOnDaily = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: {
        ...buildRequest('1m'),
        universeRule: kosdaqRule(),
      },
    });
    expect(minuteOnDaily.statusCode).toBe(400);
    // 일봉만 가진 종목에 1m 요청 — 스스로 모순되는 메시지가 아니라 "아직 데이터가 없다" 는
    // 정확한 원인을 말해야 한다
    expect(JSON.stringify(minuteOnDaily.json())).toContain('아직');
    expect(JSON.stringify(minuteOnDaily.json())).toContain('1m');
  });

  it('예상 봉 수가 상한을 넘으면 제출을 거부한다', async () => {
    // coverage 메타데이터를 부풀린다 — 상한 검사는 Parquet 을 읽지 않으므로 이걸로 충분
    const { fromTsMs, toTsMs } = {
      fromTsMs: Date.parse('2026-05-31T00:00:00Z'),
      toTsMs: Date.parse('2026-06-27T23:59:59.999Z'),
    };
    ctx.container.database.db
      .update(symbolCoverage)
      .set({ barCount: 40_000, firstTsMs: fromTsMs, lastTsMs: toTsMs })
      .where(eq(symbolCoverage.code, '005930'))
      .run();

    // 40,000 × 60 = 2,400,000 > 2,000,000 → 거부
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest('1m'),
    });
    expect(rejected.statusCode).toBe(400);
    expect(JSON.stringify(rejected.json())).toContain('봉');

    // 같은 커버리지라도 1h 소비(배율 1)는 상한 안 — 통과해야 한다
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest('1h'),
    });
    expect(accepted.statusCode).toBe(201);
  });
});
