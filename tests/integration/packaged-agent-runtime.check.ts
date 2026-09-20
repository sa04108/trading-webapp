import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRuntimeVersions, readRuntimeVersions, type RuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import type { PreparationInput } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { test as base } from '../helpers/test-fixtures.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const archive = path.resolve(process.env.QUANT_AGENT_ARCHIVE
  ?? path.join(repository, `dist/clients/quant-agent-linux-${process.arch}.tar.gz`));
const dependencies = ['better-sqlite3', 'drizzle-orm', 'pino', 'ulid', 'ws', 'zod'];
const operationTables = [
  'audit_logs', 'backtest_jobs', 'backtest_preparation_jobs',
  'operational_database_state', 'preparation_preview_cache',
];
const input: PreparationInput = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
    rebalanceInterval: { unit: 'DAY', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'range-breakout',
  parameters: {},
};
const request: BacktestRequest = {
  ...input,
  capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 },
  randomSeed: 1,
};

interface PublishedClients {
  runnerVersion: string;
  clients: Array<{ arch: string; file: string; sha256: string; bytes: number }>;
}

let temporary: string;
let packageRoot: string;
let versions: RuntimeVersions;
let files: string[];

function packageFiles(directory: string, root: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
    if (entry.isSymbolicLink()) {
      expect(fs.realpathSync(absolute).startsWith(`${root}${path.sep}`),
        `패키지 외부를 참조하는 링크: ${relative}`).toBe(true);
      return [relative];
    }
    return entry.isDirectory() ? packageFiles(absolute, root) : [relative];
  });
}

beforeAll(() => {
  if (!fs.existsSync(archive)) {
    throw new Error(`검증할 클라이언트가 없습니다: ${archive}. 먼저 pnpm build:agent를 실행하세요.`);
  }
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-packaged-agent-'));
  packageRoot = path.join(temporary, 'package');
  fs.mkdirSync(packageRoot);
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', packageRoot], { encoding: 'utf8' });
  expect(unpack.status, unpack.stderr).toBe(0);
  versions = parseRuntimeVersions(JSON.parse(fs.readFileSync(path.join(packageRoot, 'dist/runtime-versions.json'), 'utf8')));
  files = packageFiles(packageRoot, packageRoot);
});

afterAll(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

describe('다운로드용 Linux 에이전트 패키지', () => {
  it('게시 checksum과 독립 실행 경계를 만족하고 서버·웹·수집 전용 코드를 포함하지 않는다', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(archive), 'manifest.json'), 'utf8')) as PublishedClients;
    const published = manifest.clients.find((client) => client.arch === process.arch);
    expect(published).toBeDefined();
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    expect(published).toMatchObject({ file: path.basename(archive), bytes: fs.statSync(archive).size, sha256: hash.digest('hex') });
    expect(manifest).toMatchObject({ runnerVersion: versions.agentVersion });
    expect(versions, '현재 소스를 빌드한 패키지로 검증해야 합니다').toEqual(readRuntimeVersions());

    expect(fs.readdirSync(path.join(packageRoot, 'dist')).sort()).toEqual([
      'agent', 'build-info.json', 'runtime', 'runtime-versions.json', 'shared',
    ]);
    expect(fs.readdirSync(path.join(packageRoot, 'migrations'))).toEqual(['agent']);
    expect(fs.readdirSync(path.join(packageRoot, 'dist/runtime/workers')).sort()).toEqual([
      'backtest-child.js', 'cancellation.js', 'preparation-child.js', 'preparation-runtime.js', 'worker-reporting.js',
    ]);
    expect(files).toEqual(expect.arrayContaining(['bin/node', 'quant-agent', 'dist/agent/main.js', 'migrations/agent/meta/_journal.json']));
    expect(files.filter((file) => /^(src|scripts|tests|data|dist\/(server|web|workers))\//.test(file))).toEqual([]);
    expect(files.filter((file) => file.startsWith('dist/') && /\.(map|ts|tsx)$/.test(file))).toEqual([]);
    expect(files.filter((file) => /^dist\/(runtime|shared)\/.*\/(auth|presentation|dart|broker)\//.test(file))).toEqual([]);

    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>; devDependencies?: Record<string, string>;
    };
    expect(Object.keys(metadata.dependencies).sort()).toEqual(dependencies);
    expect(metadata.devDependencies).toBeUndefined();
    const migrationSql = files.filter((file) => file.startsWith('migrations/') && file.endsWith('.sql'))
      .map((file) => fs.readFileSync(path.join(packageRoot, file), 'utf8')).join('\n');
    const tables = [...migrationSql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"[]?(\w+)/gi)]
      .map((match) => match[1]).sort();
    expect(tables).toEqual(operationTables);
    const operationSchema = fs.readFileSync(path.join(packageRoot, 'dist/runtime/shared/db/operations-schema.js'), 'utf8');
    expect([...operationSchema.matchAll(/sqliteTable\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1]).sort()).toEqual(operationTables);

    const installed = files.filter((file) => file.startsWith('node_modules/') && file.endsWith('/package.json'))
      .map((file) => (JSON.parse(fs.readFileSync(path.join(packageRoot, file), 'utf8')) as { name?: string }).name)
      .filter((name): name is string => typeof name === 'string');
    expect(installed.filter((name) => /^(?:@fastify\/|@fontsource|@tanstack\/|fastify$|argon2$|react(?:-dom|-router)?$|vite$|vitest$|tsx$|typescript$)/.test(name))).toEqual([]);
  });

  const runtimeTest = base.extend({
    appOptions: { agentPreparation: true },
  });

  runtimeTest('동봉 Node와 compiled agent로 준비와 백테스트를 실행하고 결과를 서버에 저장한다', async ({ ctx }) => {
    expect(versions, '현재 소스와 배포 산출물의 버전이 달라 다시 빌드해야 합니다').toEqual(readRuntimeVersions());
    const container = ctx.container;
    const runtimeTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-packaged-agent-runtime-'));
    let child: ReturnType<typeof fork> | undefined;
    let childClosed: Promise<void> | undefined;
    let childExited = false;
    let output = '';
    let sawPreparationStart = false;
    let sawBacktestStart = false;
    let backtestId: string | undefined;
    let bundledExecutable: string | undefined;
    const waitFor = async (read: () => boolean, label: string): Promise<void> => {
      const started = Date.now();
      while (!read()) {
        if (childExited) throw new Error(`${label} 중 에이전트가 종료되었습니다: ${output}`);
        if (Date.now() - started > 50_000) throw new Error(`${label} 대기 시간 초과: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
    seedSymbolMasterUniverse(container, ['2026-01-05'], [{
      standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '1000000000',
    }]);
    registerSymbols(container, 'KR', ['005930']);
    seedDailyBars(container.database.db, [{
      symbol: '005930', market: 'KR', timeframe: '1d', tsMs: Date.parse('2026-01-05T00:00:00Z'),
      open: 100, high: 110, low: 90, close: 105, volume: 1000,
    }]);
    await seedCorporateActionCoverage(container, ['005930'], [2024, 2025, 2026]);
    const resolver = vi.spyOn(container.universeRuleResolver, 'resolveOrDescribeNeeds');
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const credential = container.agentCoordinator.registry.issue('packaged-integration-test');
    container.agentCoordinator.start({ local: false });
    const preparation = container.backtestPreparationOrchestrator.start(input);
    const state = path.join(runtimeTemporary, 'state');
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ serverUrl: address, token: credential.token }), { mode: 0o600 });
    const bootstrap = path.join(runtimeTemporary, 'bootstrap.mjs');
    fs.copyFileSync(new URL('../helpers/packaged-agent-bootstrap.mjs', import.meta.url), bootstrap);
    // PATH·환경·작업 폴더에서 저장소의 Node, loader, node_modules를 참조하지 않는다.
    child = fork(bootstrap, [packageRoot, state], {
      execPath: path.join(packageRoot, 'bin/node'),
      execArgv: [],
      cwd: packageRoot,
      env: { NODE_ENV: 'production', PATH: path.join(packageRoot, 'bin') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const capture = (chunk: Buffer) => {
      const captured = output + chunk.toString();
      if (captured.includes(`PREPARATION 작업 시작: ${preparation.id}`)) sawPreparationStart = true;
      if (backtestId !== undefined && captured.includes(`BACKTEST 작업 시작: ${backtestId}`)) sawBacktestStart = true;
      output = captured.slice(-8_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (error) => { output += error.message; });
    child.on('message', (message: { type?: string; executable?: string }) => {
      if (message.type === 'STARTED') bundledExecutable = message.executable;
    });
    childClosed = new Promise((resolve) => child!.once('close', (code, signal) => {
      childExited = true;
      output += `\nexit=${code}, signal=${signal}`;
      resolve();
    }));
    await waitFor(() => bundledExecutable !== undefined, '패키지 시작');
    expect(bundledExecutable).toBe(path.join(packageRoot, 'bin/node'));
    await waitFor(() => {
      const job = container.backtestPreparationOrchestrator.get(preparation.id);
      return job !== null && container.backtestPreparationOrchestrator.isTerminal(job.status);
    }, '준비 작업');
    expect(container.backtestPreparationOrchestrator.get(preparation.id), output).toMatchObject({ status: 'COMPLETED', error: null });
    expect(container.database.sqlite.prepare('SELECT client_id FROM agent_preparation_leases WHERE job_id = ?').get(preparation.id))
      .toEqual({ client_id: credential.id });
    const preview = container.backtestPreparationOrchestrator.getFreshPreviewDetails(input)?.preview;
    expect(preview?.unionSymbols).toEqual(['005930']);
    expect(resolver).not.toHaveBeenCalled();
    if (!preview) throw new Error('완료된 준비 작업의 미리보기가 없습니다');

    const schedule = preview.schedule.map((entry) => ({
      rebalanceDate: entry.rebalanceDate,
      effectiveTradingDate: entry.effectiveDate,
      symbols: entry.members.map((member) => member.symbol),
      members: entry.members,
      excludedNonTradingCount: entry.excludedNonTradingCount,
    }));
    const backtest = container.jobQueue.enqueue(request, schedule);
    backtestId = backtest.id;
    await waitFor(() => /^(COMPLETED|FAILED|CANCELLED)$/.test(container.jobQueue.getJob(backtest.id)?.status ?? ''), '백테스트');
    expect(container.jobQueue.getJob(backtest.id), output).toMatchObject({
      status: 'COMPLETED', error: null, agentId: credential.id, attempt: 1,
    });
    expect(container.resultsService.getRun(backtest.id)).toMatchObject({ executionVersion: versions.executionVersion });
    expect(container.resultsService.getMetrics(backtest.id)).not.toBeNull();
    expect(container.resultsService.getFullExport(backtest.id).equityPoints.length).toBeGreaterThan(0);
    expect(sawPreparationStart).toBe(true);
    expect(sawBacktestStart).toBe(true);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)|버전이 다릅니다/);
    } finally {
      if (child !== undefined && !childExited) {
        const timeout = setTimeout(() => child?.kill('SIGKILL'), 10_000);
        child.kill('SIGTERM');
        try { await childClosed; } finally { clearTimeout(timeout); }
      }
      fs.rmSync(runtimeTemporary, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
