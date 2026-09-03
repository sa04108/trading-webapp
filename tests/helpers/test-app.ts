import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { createContainer, type Container } from '../../src/server/bootstrap/container.js';
import { buildServer } from '../../src/server/bootstrap/server.js';
import { newId } from '../../src/server/shared/ids.js';
import { symbolMasterCoverage } from '../../src/server/shared/db/schema.js';

export interface TestApp {
  app: FastifyInstance;
  container: Container;
  dir: string;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  configure?: (app: FastifyInstance) => void,
): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path.join(dir, 'app.sqlite'),
    DATA_ROOT: path.join(dir, 'market-data'),
    IMPORT_ROOT: path.join(dir, 'imports'),
    EXPORT_ROOT: path.join(dir, 'exports'),
    TEMP_ROOT: path.join(dir, 'temp'),
    SESSION_SECRET: 's'.repeat(48),
    LOG_LEVEL: 'error',
    ...env,
  });
  const container = createContainer(config);
  const app = await buildServer(container);
  configure?.(app); // 테스트 전용 라우트 등록 등 — ready() 전에만 가능
  await app.ready();

  return {
    app,
    container,
    dir,
    async close() {
      await app.close();
      await container.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Task 6 이전부터 있던 제출/worker 통합 테스트가 관찰하려는 것은 queue 이후다.
 * 그 테스트들에서만 DART 외부 호출을 no-op으로 격리하고, 첫 409 뒤 동일 요청의
 * durable preparation을 완료한 다음 원 요청을 재시도한다. preparation 자체의 실제
 * registry/coverage/DART 계약은 backtest-preparation.test.ts가 별도로 검증한다.
 */
export function installPreparedSubmissionFixture(ctx: TestApp): void {
  const readActualValidDates = ctx.container.candleCoverageService
    .getValidDatesByCodeBetween.bind(ctx.container.candleCoverageService);
  const noWorkPlan = {
    yearsBySymbol: new Map(),
    shareYearsBySymbol: new Map(),
    todayKstDate: '2026-01-01',
    calls: 0,
    estimatedMs: 0,
    overDailyLimit: false,
  };
  const planFinancialSync: typeof ctx.container.factSyncService.planFinancialSync = () => noWorkPlan;
  const planCorporateActionSync: typeof ctx.container.factSyncService.planCorporateActionSync = () => noWorkPlan;
  ctx.container.factSyncService.planFinancialSync = planFinancialSync;
  ctx.container.factSyncService.planCorporateActionSync = planCorporateActionSync;
  ctx.container.factSyncService.sync = async (request) => {
    // DART가 공시 0건을 정상 반환해도 요청한 연도는 완전히 조회한 상태다. 준비 완료
    // 불변식을 실제 서비스와 같게 만들되, 외부 호출과 fact 행 생성만 생략한다.
    const years: number[] = [];
    for (let year = request.fromYear; year <= request.toYear; year += 1) years.push(year);
    for (const symbol of request.symbols) {
      ctx.container.factCoverageStore.addCoveredYears(
        symbol,
        years,
        ctx.container.clock.now(),
      );
    }
    return {
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    };
  };
  ctx.container.factSyncService.syncCorporateActions = async (request) => {
    // 외부 DART만 no-op으로 격리하되, 성공한 준비가 남겨야 할 현재 protocol coverage는
    // 실제 서비스와 동일하게 기록한다. 그렇지 않으면 worker의 최종 fail-closed가
    // 테스트 fixture 자체를 구버전/미수집 데이터로 올바르게 거부한다.
    const years: number[] = [];
    for (let year = request.fromYear; year <= request.toYear; year += 1) years.push(year);
    for (const symbol of request.symbols) {
      ctx.container.actionCoverageStore.addCoverageResult(
        symbol,
        years,
        [],
        ctx.container.clock.now(),
      );
    }
    return {
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    };
  };
  ctx.container.candleCoverageService.getValidDatesByCodeBetween = (codes, from, to) => {
    const tradingDays = ctx.container.symbolMasterService.tradingDaysBetween(from, to);
    const actual = readActualValidDates(codes, from, to);
    return new Map(codes.map((code) => [
      code,
      (actual.get(code)?.length ?? 0) > 0
        ? [...new Set([...(actual.get(code) ?? []), ...tradingDays])].sort()
        : [],
    ]));
  };

  const waitForPreparation = async (jobId: string): Promise<boolean> => {
    const started = Date.now();
    for (;;) {
      const status = ctx.container.backtestPreparationOrchestrator.get(jobId)?.status;
      if (status === 'COMPLETED') return true;
      if (status === 'FAILED' || status === 'CANCELLED') return false;
      if (Date.now() - started > 5_000) throw new Error('preparation fixture timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const rawInject = ctx.app.inject.bind(ctx.app);
  ctx.app.inject = (async (options: unknown) => {
    const request = options as {
      method?: string;
      url?: string;
      payload?: BacktestRequest;
      cookies?: Record<string, string>;
    };
    const first = await rawInject(options as never);
    const isSubmit = request.method === 'POST' && request.url === '/api/v1/backtests';
    const cloneMatch = request.method === 'POST'
      ? /^\/api\/v1\/backtests\/([^/]+)\/clone$/.exec(request.url ?? '')
      : null;
    if (
      (!isSubmit && cloneMatch === null)
      || first.statusCode !== 409
      || (first.json() as { error?: string }).error !== 'PREPARATION_REQUIRED'
    ) return first;

    let body = request.payload;
    if (body === undefined && cloneMatch !== null) {
      const draft = await rawInject({
        method: 'GET',
        url: `/api/v1/backtests/${cloneMatch[1]}/clone-draft`,
        cookies: request.cookies,
      });
      if (draft.statusCode !== 200) return first;
      body = (draft.json() as { request: BacktestRequest }).request;
    }
    if (body === undefined) return first;

    // queue 이후를 검증하는 fixture이므로 preparation의 기간 전체 KRX 백필은 외부 호출
    // 없이 완료된 것으로 만든다. 개별 테스트가 coverage drift를 검증할 때는 이 준비 뒤
    // 행을 삭제·교체하므로 실제 제출/worker 방어선은 그대로 탄다.
    ctx.container.database.db.insert(symbolMasterCoverage).values({
      startDate: body.period.from,
      endDate: body.period.to,
      syncedAtMs: ctx.container.clock.now(),
    }).run();

    const preparation = ctx.container.backtestPreparationOrchestrator.start({
      universeRule: body.universeRule,
      period: body.period,
      strategyId: body.strategyId,
      parameters: body.parameters,
    });
    if (!await waitForPreparation(preparation.id)) return first;
    return rawInject(options as never);
  }) as typeof ctx.app.inject;
}

export interface TestAdminOptions {
  username?: string;
  password?: string;
  totpEnabled?: boolean;
  recoveryCodes?: string[];
}

export async function createTestAdmin(
  container: Container,
  options: TestAdminOptions = {},
): Promise<{ username: string; password: string; totpSecret: string | null }> {
  const username = options.username ?? 'operator';
  const password = options.password ?? 'correct-horse-battery-staple';
  const totpEnabled = options.totpEnabled ?? false;
  const totpSecret = totpEnabled ? container.totpService.generateSecret() : null;

  const recoveryCodeHashes: string[] = [];
  for (const code of options.recoveryCodes ?? []) {
    recoveryCodeHashes.push(await container.passwordHasher.hash(code));
  }

  container.userRepository.create(
    {
      id: newId('usr'),
      username,
      passwordHash: await container.passwordHasher.hash(password),
      totpSecret,
      totpEnabled,
      totpLastUsedStep: null,
      recoveryCodeHashes,
    },
    container.clock.now(),
  );

  return { username, password, totpSecret };
}
