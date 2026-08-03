import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { backtestJobs, universeSnapshots } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedDataset } from '../helpers/seed.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const DAY = 86_400_000;
const isoToBasDd = (iso: string): string => iso.replaceAll('-', '');

/**
 * Task 12 — 백테스트 계약: datasetId xor universeSnapshotId, 시점 게이트,
 * 서버 소유 provenance pin. 스냅샷은 실제 preview → snapshot 생성 HTTP 경로로
 * 만든다 (universe-routes.test.ts 와 같은 패턴) — 서비스 내부를 흉내 내면 실제
 * 배선(usableFromDate 계산, symbols 등록)이 빠질 수 있다.
 */

/** 정상 거래일 하나 — KOSPI(005930)·KOSDAQ(035720) 각 1건. */
function seedTradingDay(fake: KrxFakeServer, iso: string): void {
  const basDd = isoToBasDd(iso);
  fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([baseInfoFixture({ ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930' })]),
  });
  fake.setResponse('stk_bydd_trd', basDd, {
    body: krxEnvelope([dailyFixture({ ISU_CD: '005930', MKTCAP: '350,000,000,000,000' })]),
  });
  fake.setResponse('ksq_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({ ISU_CD: 'KR7035720002', ISU_SRT_CD: '035720', ISU_NM: '카카오', MKT_TP_NM: 'KOSDAQ' }),
    ]),
  });
  fake.setResponse('ksq_bydd_trd', basDd, {
    body: krxEnvelope([dailyFixture({ ISU_CD: '035720', ISU_NM: '카카오', MKTCAP: '20,000,000,000,000' })]),
  });
}

interface Ctx {
  readonly app: TestApp;
  readonly fake: KrxFakeServer;
  readonly cookie: string;
}

const openCtxs: Ctx[] = [];

async function setupCtx(env: Record<string, string> = {}): Promise<Ctx> {
  const fake = await startKrxFakeServer();
  const app = await createTestApp({
    KRX_BASE_URL: fake.baseUrl,
    KRX_API_KEY: 'test-krx-key',
    ...env,
  });
  const { username, password } = await createTestAdmin(app.container);
  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  const ctx = { app, fake, cookie };
  openCtxs.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const ctx of openCtxs.splice(0)) {
    await ctx.app.close();
    await ctx.fake.close();
  }
});

interface Snapshot {
  readonly id: string;
  readonly shortCodes: string[];
  readonly usableFromDate: string;
  readonly effectiveTradingDate: string;
}

/** preview → snapshot 생성 HTTP 경로로 실제 스냅샷을 만든다. */
async function createSnapshot(
  ctx: Ctx,
  date: string,
  pickCount: 1 | 2 = 1,
): Promise<Snapshot> {
  seedTradingDay(ctx.fake, date);
  const previewRes = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/v1/universe/historical/preview',
    cookies: { qp_session: ctx.cookie },
    payload: { date },
  });
  expect(previewRes.statusCode).toBe(200);
  const preview = previewRes.json();

  const standardCodes = preview.candidates
    .slice(0, pickCount)
    .map((c: { standardCode: string }) => c.standardCode);

  const snapshotRes = await ctx.app.app.inject({
    method: 'POST',
    url: '/api/v1/universe/snapshots',
    cookies: { qp_session: ctx.cookie },
    payload: {
      previewId: preview.previewId,
      standardCodes,
      selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
    },
  });
  expect(snapshotRes.statusCode).toBe(201);
  const { snapshot } = snapshotRes.json();

  return {
    id: snapshot.id,
    shortCodes: snapshot.symbols.map((s: { shortCode: string }) => s.shortCode).sort(),
    usableFromDate: snapshot.usableFromDate,
    effectiveTradingDate: snapshot.effectiveTradingDate,
  };
}

function buildDailyCandles(code: string, fromIso: string, toIso: string): Candle[] {
  const candles: Candle[] = [];
  const end = Date.parse(`${toIso}T00:00:00Z`);
  let cursor = Date.parse(`${fromIso}T00:00:00Z`);
  let index = 0;
  while (cursor <= end) {
    const dayOfWeek = new Date(cursor).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const phase = index % 60;
      const base = phase < 35 ? 60_000 + phase * 400 : 74_000 - (phase - 35) * 500;
      const open = base;
      const close = base + 300;
      candles.push({
        symbol: code,
        market: 'KR',
        timeframe: '1d',
        tsMs: cursor,
        open,
        high: close + 200,
        low: open - 400,
        close,
        volume: 1_000_000,
      });
      index += 1;
    }
    cursor += DAY;
  }
  return candles;
}

async function seedCandles(ctx: Ctx, code: string, fromIso: string, toIso: string): Promise<Candle[]> {
  const candles = buildDailyCandles(code, fromIso, toIso);
  await ctx.app.container.candleRepository.saveCandles(candles);
  await ctx.app.container.symbolService.refreshCoverage(code, 'KR', '1d');
  ctx.app.container.symbolService.bumpVersion(code, '1d', 'krx:seed', Date.now());
  return candles;
}

function rangeBreakoutRequest(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    strategyId: 'range-breakout',
    parameters: {
      lookbackBars: 10,
      atrPeriod: 5,
      stopAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      riskPerTradePercent: 2,
    },
    capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: {
      fillTiming: 'NEXT_BAR_OPEN',
      commissionProfileId: 'kr-equity-default',
      slippageProfileId: 'fixed-5bps',
    },
    risk: { maxPositions: 5 },
    randomSeed: 42,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('백테스트 유니버스 스냅샷 계약 (Task 12)', () => {
  it('스냅샷 경로: universe.symbols 가 스냅샷 구성과 다르면 400 이다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: ['999999'] },
        period: { from: '2025-02-01', to: '2025-03-01' },
      }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('적용일(effectiveTradingDate) >= 시작일은 두 날짜와 해결책을 담아 400 이다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    // effectiveTradingDate 보다 앞선 시작일은 차단된다 (REVIEW §9) — usableFromDate
    // (= effectiveTradingDate + 1일) 가 기준이 아니다: 그 기준이면 스펙보다 하루 더
    // 엄격해져 사용 가능 첫날(period.from == usableFromDate) 제출까지 막힌다.
    const before = new Date(Date.parse(`${snapshot.effectiveTradingDate}T00:00:00Z`) - DAY)
      .toISOString()
      .slice(0, 10);

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from: before, to: '2025-06-01' },
      }),
    });

    expect(res.statusCode).toBe(400);
    const error = res.json().error as string;
    expect(error).toContain(`적용일 ${snapshot.effectiveTradingDate}는 시작일 ${before}보다 이전이어야 합니다`);
    expect(error).toContain('더 이른 스냅샷을 선택하거나 시작일을 늦추세요');
  });

  it('적용일(effectiveTradingDate) == 시작일도 차단한다 — 종가 정보는 그날 세션 시작에 알 수 없다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from: snapshot.effectiveTradingDate, to: '2025-06-01' },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error as string).toContain(
      `적용일 ${snapshot.effectiveTradingDate}는 시작일 ${snapshot.effectiveTradingDate}보다 이전이어야 합니다`,
    );
  });

  it('period.from == usableFromDate(사용 가능 첫날)는 통과한다 — effectiveTradingDate 보다 하루 뒤라 게이트 대상이 아니다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    // usableFromDate 자체는 게이트 기준이 아니다 — effectiveTradingDate < usableFromDate
    // 이므로 이 날짜로 시작하는 제출은 통과해야 한다 (회귀: 이전엔 usableFromDate 를
    // 기준으로 비교해 이 경계를 잘못 차단했다).
    const from = snapshot.usableFromDate;
    const to = '2025-06-30';
    await seedCandles(ctx, snapshot.shortCodes[0]!, from, to);

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from, to },
      }),
    });

    expect(res.statusCode).toBe(201);
  });

  it('적용일 < 시작일이고 데이터가 있으면 통과한다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    const from = '2025-01-08'; // usableFromDate(2025-01-07) 보다 뒤
    const to = '2025-06-30';
    await seedCandles(ctx, snapshot.shortCodes[0]!, from, to);

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from, to },
      }),
    });

    expect(res.statusCode).toBe(201);
  });

  it('KRX 승인 만료 후 스냅샷 기반 신규 실행은 차단된다', async () => {
    // 승인이 만료된 상태에서는 미리보기·스냅샷 저장 자체가 막힌다 — 이 시나리오는
    // "승인이 유효할 때 만든 스냅샷을, 승인이 만료된 뒤 새로 실행" 하는 경우다.
    // 같은 프로세스 안에서 config(만료일)를 바꿀 수 없으므로 같은 DB 파일을 두 앱이
    // 순서대로 열어 재현한다: 먼저 만료 전 앱에서 스냅샷을 만들고 닫은 뒤, 만료된
    // 설정의 새 앱으로 그 DB 를 다시 열어 신규 제출을 시도한다.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-usn-expiry-'));
    const dbPath = path.join(dbDir, 'app.sqlite');
    try {
      const before = await setupCtx({ DATABASE_PATH: dbPath });
      const snapshot = await createSnapshot(before, '2025-01-06', 1);
      await before.app.close();
      await before.fake.close();
      openCtxs.splice(openCtxs.indexOf(before), 1);

      const fake = await startKrxFakeServer();
      const app = await createTestApp({
        KRX_BASE_URL: fake.baseUrl,
        KRX_API_KEY: 'test-krx-key',
        KRX_APPROVAL_EXPIRY: '2020-01-01',
        DATABASE_PATH: dbPath,
      });
      const login = await app.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'operator', password: 'correct-horse-battery-staple' },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
      const ctx = { app, fake, cookie };
      openCtxs.push(ctx);

      const res = await ctx.app.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: ctx.cookie },
        payload: rangeBreakoutRequest({
          universeSnapshotId: snapshot.id,
          universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
          period: { from: '2025-01-08', to: '2025-06-30' },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error as string).toContain('승인');
    } finally {
      // Windows 는 방금 닫은 sqlite 파일의 핸들 반환이 테스트 프로세스 종료 후까지
      // 늦어질 수 있다 — 정리 실패는 임시 디렉터리 하나가 남는 것뿐이라 테스트
      // 결과(단언)를 삼키지 않는다.
      try {
        fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // best-effort cleanup — 무시
      }
    }
  });

  it('기간 내 가격 데이터가 전혀 없는 스냅샷 종목이 있으면 코드를 나열하며 차단한다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 2);
    const [withData, withoutData] = snapshot.shortCodes;
    await seedCandles(ctx, withData!, '2025-01-08', '2025-06-30');
    // withoutData 는 봉을 넣지 않는다 — 신규 상장 등으로 정상일 수 있어도 유니버스
    // 전체를 막아야 한다 (생존 편향 재발 방지, REVIEW §9.1)

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from: '2025-01-08', to: '2025-06-30' },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error as string).toContain(withoutData);
  });

  it('200 종목 초과 유니버스는 기존 정책대로 차단한다', async () => {
    const ctx = await setupCtx();
    const symbols = Array.from({ length: 201 }, (_, i) => String(i + 1).padStart(6, '0'));

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: 'usn_does_not_matter',
        universe: { type: 'SYMBOLS', symbols },
        period: { from: '2025-01-08', to: '2025-06-30' },
      }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('없는 snapshotId 는 404 다', async () => {
    const ctx = await setupCtx();

    const res = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: 'usn_missing',
        universe: { type: 'SYMBOLS', symbols: ['005930'] },
        period: { from: '2025-01-08', to: '2025-06-30' },
      }),
    });

    expect(res.statusCode).toBe(404);
  });

  it('job 에 universeSnapshotId·서버 소유 pin 이 저장되고 run 에 복사된다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    const from = '2025-01-08';
    const to = '2026-01-08';
    await seedCandles(ctx, snapshot.shortCodes[0]!, from, to);

    const created = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from, to },
      }),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    const job = ctx.app.container.jobQueue.getJob(jobId)!;
    expect(job.universeSnapshotId).toBe(snapshot.id);
    expect(job.provenancePinJson).not.toBeNull();
    const jobPin = JSON.parse(job.provenancePinJson!);
    expect(jobPin.sourceKind).toBe('KRX_HISTORICAL');
    expect(jobPin.universeSnapshotId).toBe(snapshot.id);
    expect(jobPin.symbols).toHaveLength(1);
    // DB 컬럼은 NOT NULL 이라 '' sentinel 을 쓴다 — API 응답까지 새면 안 된다(아래 확인)
    expect(job.datasetId).toBe('');

    const detailBeforeRun = await ctx.app.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: ctx.cookie },
    });
    expect(detailBeforeRun.statusCode).toBe(200);
    expect(detailBeforeRun.json().job.datasetId).toBeNull();
    expect(detailBeforeRun.json().provenancePin).toMatchObject({
      sourceKind: 'KRX_HISTORICAL',
      universeSnapshotId: snapshot.id,
    });

    const listBeforeRun = await ctx.app.app.inject({
      method: 'GET',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
    });
    expect(listBeforeRun.statusCode).toBe(200);
    const listedJob = (listBeforeRun.json().jobs as Array<{ id: string; datasetId: string | null }>).find(
      (j) => j.id === jobId,
    );
    expect(listedJob?.datasetId).toBeNull();

    ctx.app.container.jobOrchestrator.tick();
    await waitFor(() => {
      const current = ctx.app.container.jobQueue.getJob(jobId);
      return current !== null && ctx.app.container.jobQueue.isTerminal(current.status);
    }, 60_000);

    const finished = ctx.app.container.jobQueue.getJob(jobId)!;
    expect(finished.status).toBe('COMPLETED');
    const run = ctx.app.container.resultsService.getRun(jobId)!;
    expect(run.provenancePinJson).toBe(job.provenancePinJson);
    // run 도 job.datasetId('') 를 그대로 복사한다 — 같은 sentinel, 같은 정규화가 필요하다
    expect(run.datasetId).toBe('');

    const detailAfterRun = await ctx.app.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: ctx.cookie },
    });
    expect(detailAfterRun.json().provenancePin).toMatchObject({ sourceKind: 'KRX_HISTORICAL' });
    expect(detailAfterRun.json().job.datasetId).toBeNull();
    expect(detailAfterRun.json().run.datasetId).toBeNull();
  }, 90_000);

  it('pin 의 종목 버전 스냅샷이 스냅샷 구성 종목만 커버한다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 2);
    for (const code of snapshot.shortCodes) {
      await seedCandles(ctx, code, '2025-01-08', '2025-06-30');
    }

    const created = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from: '2025-01-08', to: '2025-06-30' },
      }),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    const job = ctx.app.container.jobQueue.getJob(jobId)!;
    const entries = JSON.parse(job.universeJson!) as Array<{ code: string }>;
    const codes = new Set(entries.map((e) => e.code));
    expect([...codes].sort()).toEqual(snapshot.shortCodes);
  });

  it('데이터셋 경로는 기존 검증을 유지하고 pin.sourceKind=DATASET·시점 불명 경고를 남긴다', async () => {
    const ctx = await setupCtx();
    const dataset = seedDataset(ctx.app.container, 'kr-daily-v1', 'KR', ['005930']);
    const from = '2025-01-08';
    const to = '2026-01-08';
    await seedCandles(ctx, '005930', from, to);

    const created = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        datasetId: dataset.id,
        universe: { type: 'SYMBOLS', symbols: ['005930'] },
        period: { from, to },
      }),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    const job = ctx.app.container.jobQueue.getJob(jobId)!;
    expect(job.universeSnapshotId).toBeNull();
    expect(job.datasetId).toBe(dataset.id);
    const jobPin = JSON.parse(job.provenancePinJson!);
    expect(jobPin.sourceKind).toBe('DATASET');
    expect(jobPin.timepointWarning).toContain('과거 시점 적합성을 확인할 수 없습니다');

    // 회귀 확인: datasetId 정규화('' → null)는 스냅샷 경로의 sentinel 에만 적용된다 —
    // 데이터셋 경로의 실제 id 는 그대로 노출돼야 한다.
    const detail = await ctx.app.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: ctx.cookie },
    });
    expect(detail.json().job.datasetId).toBe(dataset.id);

    ctx.app.container.jobOrchestrator.tick();
    await waitFor(() => {
      const current = ctx.app.container.jobQueue.getJob(jobId);
      return current !== null && ctx.app.container.jobQueue.isTerminal(current.status);
    }, 60_000);

    const finished = ctx.app.container.jobQueue.getJob(jobId)!;
    expect(finished.status).toBe('COMPLETED');
    const run = ctx.app.container.resultsService.getRun(jobId)!;
    expect(run.datasetId).toBe(dataset.id);
    const runPin = JSON.parse(run.provenancePinJson!);
    expect(runPin.sourceKind).toBe('DATASET');
    const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
    expect(warnings.some((w) => w.includes('과거 시점 적합성을 확인할 수 없습니다'))).toBe(true);

    const detailAfterRun = await ctx.app.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: ctx.cookie },
    });
    expect(detailAfterRun.json().run.datasetId).toBe(dataset.id);
  }, 90_000);

  it('provenancePinJson 행이 손상돼 있어도 상세 조회는 500 이 아니라 pin=null 로 성공한다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    const from = '2025-01-08';
    const to = '2025-06-30';
    await seedCandles(ctx, snapshot.shortCodes[0]!, from, to);

    const created = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from, to },
      }),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    // 손상 행을 직접 재현한다 — 수동 DB 편집·마이그레이션 실수 등으로 이 컬럼만
    // JSON 이 아닌 값을 갖게 될 수 있다.
    ctx.app.container.database.db
      .update(backtestJobs)
      .set({ provenancePinJson: '{이것은 유효한 JSON 이 아니다' })
      .where(eq(backtestJobs.id, jobId))
      .run();

    const detail = await ctx.app.app.inject({
      method: 'GET',
      url: `/api/v1/backtests/${jobId}`,
      cookies: { qp_session: ctx.cookie },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().provenancePin).toBeNull();
    expect(detail.json().job.id).toBe(jobId);
  });

  it('clone: 스냅샷이 삭제(부재)면 명확한 오류로 차단한다', async () => {
    const ctx = await setupCtx();
    const snapshot = await createSnapshot(ctx, '2025-01-06', 1);
    const from = '2025-01-08';
    const to = '2025-06-30';
    await seedCandles(ctx, snapshot.shortCodes[0]!, from, to);

    const created = await ctx.app.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: ctx.cookie },
      payload: rangeBreakoutRequest({
        universeSnapshotId: snapshot.id,
        universe: { type: 'SYMBOLS', symbols: snapshot.shortCodes },
        period: { from, to },
      }),
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    // 스냅샷 삭제 — 불변 저장이지만 보존 정책 등으로 사라질 수 있는 상태를 재현한다
    ctx.app.container.database.db.delete(universeSnapshots).where(eq(universeSnapshots.id, snapshot.id)).run();

    const cloned = await ctx.app.app.inject({
      method: 'POST',
      url: `/api/v1/backtests/${jobId}/clone`,
      cookies: { qp_session: ctx.cookie },
    });

    expect(cloned.statusCode).toBe(404);
    expect(cloned.json().error as string).toContain(snapshot.id);
  });
});
