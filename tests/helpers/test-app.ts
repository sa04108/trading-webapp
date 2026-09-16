import { AgentClient } from '../../src/agent/client.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BacktestPreparationJobDto } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { createContainer, type Container } from '../../src/server/bootstrap/container.js';
import { buildServer } from '../../src/server/bootstrap/server.js';
import { newId } from '../../src/runtime/shared/ids.js';

export interface TestApp {
  app: FastifyInstance;
  container: Container;
  dir: string;
  startAgent(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  configure?: (app: FastifyInstance) => void,
  agentPreparation = false,
): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-'));
  let container: Container | null = null;
  let app: FastifyInstance | null = null;
  try {
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
    container = createContainer(config, { inlinePreparation: !agentPreparation });
    app = await buildServer(container);
    configure?.(app); // 테스트 전용 라우트 등록 등 — ready() 전에만 가능
    await app.ready();
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (app !== null) {
      try { await app.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (container !== null) {
      try { await container.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length === 0) fs.rmSync(dir, { recursive: true, force: true });
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        '테스트 앱 생성과 정리에 실패했습니다.',
        { cause: error },
      );
    throw error;
  }

  if (container === null || app === null)
    throw new Error('테스트 앱 초기화 결과가 없습니다');

  const readyContainer = container;
  const readyApp = app;

  let agent: AgentClient | null = null;
  let closing: Promise<void> | null = null;
  return {
    app: readyApp,
    container: readyContainer,
    dir,
    async startAgent() {
      if (closing !== null) throw new Error('종료 중인 테스트 앱은 agent를 시작할 수 없습니다');
      if (agent) return;
      const address = await readyApp.listen({ host: '127.0.0.1', port: 0 });
      const credential = readyContainer.agentCoordinator.registry.issue('integration-test');
      readyContainer.agentCoordinator.start({ local: false });
      agent = new AgentClient({ serverUrl: address, token: credential.token }, path.join(dir, 'agent'), undefined, () => undefined);
      agent.start();
    },
    close() {
      if (closing !== null) return closing;
      closing = (async () => {
        const errors: unknown[] = [];
        try { await agent?.stop(); } catch (error) { errors.push(error); }
        try { await readyApp.close(); } catch (error) { errors.push(error); }
        try { await readyContainer.close(); } catch (error) { errors.push(error); }
        if (errors.length === 0) fs.rmSync(dir, { recursive: true, force: true });
        if (errors.length > 0)
          throw new AggregateError(errors, '테스트 앱 자원 정리에 실패했습니다.');
      })();
      return closing;
    },
  };
}

const PREPARATION_FIXTURE_TIMEOUT_MS = 5_000;

export async function waitForPreparationFixture(
  readJob: () => BacktestPreparationJobDto | null,
  jobId: string,
  timeoutMs = PREPARATION_FIXTURE_TIMEOUT_MS,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const job = readJob();
    if (job?.status === 'COMPLETED') return true;
    if (job?.status === 'FAILED' || job?.status === 'CANCELLED') return false;
    const elapsedMs = Date.now() - started;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`preparation fixture timeout: ${JSON.stringify({
        jobId,
        elapsedMs,
        status: job?.status ?? 'MISSING',
        phase: job?.phase ?? null,
        progress: job === null ? null : {
          doneSymbols: job.doneSymbols,
          totalSymbols: job.totalSymbols,
          savedFacts: job.savedFacts,
          gapCount: job.gapCount,
        },
        error: job?.error ?? null,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
