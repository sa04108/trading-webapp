import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../../src/server/bootstrap/container.js';

const BENCHMARK_USERNAME = 'universe_benchmark';
const BENCHMARK_PASSWORD = 'benchmark-only-password-do-not-reuse';

function sendMemorySample(label: string): void {
  const usage = process.memoryUsage();
  let pssBytes = 0;
  let pssAnonBytes = 0;
  let pssFileBytes = 0;
  try {
    const rollup = fs.readFileSync('/proc/self/smaps_rollup', 'utf8');
    const kib = (name: string): number => Number(
      new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(rollup)?.[1] ?? 0,
    );
    pssBytes = kib('Pss') * 1024;
    pssAnonBytes = kib('Pss_Anon') * 1024;
    pssFileBytes = kib('Pss_File') * 1024;
  } catch {
    // Non-Linux manual runs still retain process.memoryUsage fields.
  }
  process.send?.({
    type: 'memory', label, ...usage, pssBytes, pssAnonBytes, pssFileBytes,
  });
}

function requiredDatabasePath(argv: readonly string[]): string {
  const index = argv.indexOf('--database');
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined) throw new Error('--database가 필요합니다.');
  return path.resolve(value);
}

function executionMode(argv: readonly string[]): 'inline' | 'forked' {
  const index = argv.indexOf('--execution');
  const value = index < 0 ? 'forked' : argv[index + 1];
  if (value !== 'inline' && value !== 'forked') throw new Error('--execution이 올바르지 않습니다.');
  return value;
}

function requiredDartBaseUrl(argv: readonly string[]): string {
  const index = argv.indexOf('--dart-base-url');
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || !value.startsWith('http://127.0.0.1:')) {
    throw new Error('--dart-base-url에는 controller가 연 loopback URL이 필요합니다.');
  }
  return value;
}

function integerOption(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  const raw = index < 0 ? undefined : argv[index + 1];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag}가 올바르지 않습니다.`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const databasePath = requiredDatabasePath(argv);
  const synthetic = argv.includes('--synthetic');
  const dartBaseUrl = synthetic ? requiredDartBaseUrl(argv) : 'http://127.0.0.1:9';
  const preparationChildMaxRssMiB = integerOption(
    argv, '--preparation-child-max-rss-mib', 320,
  );
  const preparationChildOldSpaceMiB = integerOption(
    argv, '--preparation-child-old-space-mib', 128,
  );
  const built = argv.includes('--built');
  const runtimeRoot = built ? '../../dist/server' : '../../src/server';
  const [{ loadConfig }, { createContainer }, { buildServer }, { newId }] = await Promise.all([
    import(`${runtimeRoot}/bootstrap/config.js`),
    import(`${runtimeRoot}/bootstrap/container.js`),
    import(`${runtimeRoot}/bootstrap/server.js`),
    import(`${runtimeRoot}/shared/ids.js`),
  ]);
  const root = path.dirname(databasePath);

  // 하네스가 실수로 외부 adapter를 호출하면 네트워크 요청 전에 즉시 실패한다.
  // synthetic fixture만 controller의 결정적 DART 013 응답을 허용한다. 실제 snapshot은
  // 누락 데이터를 조용히 채우지 않고 loopback discard/deny 오류로 NEEDS_DATA를 드러낸다.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const target = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (!target.startsWith(`${dartBaseUrl}/`)) {
      throw new Error(`universe benchmark forbids external fetch: ${new URL(target).origin}`);
    }
    return nativeFetch(input, init);
  }) as typeof globalThis.fetch;

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    DATA_ROOT: path.join(root, 'market-data'),
    IMPORT_ROOT: path.join(root, 'imports'),
    EXPORT_ROOT: path.join(root, 'exports'),
    TEMP_ROOT: path.join(root, 'temp'),
    SESSION_SECRET: 'benchmark-session-secret-'.repeat(3),
    LOG_LEVEL: 'error',
    DART_API_KEY: 'benchmark-placeholder-no-network',
    DART_BASE_URL: dartBaseUrl,
    KRX_BASE_URL: 'http://127.0.0.1:9',
    FRED_BASE_URL: 'http://127.0.0.1:9',
    TOSS_BASE_URL: 'http://127.0.0.1:9',
    BACKTEST_EXECUTION_MODE: 'local',
    PREPARATION_CHILD_MAX_RSS_MB: String(preparationChildMaxRssMiB),
    PREPARATION_CHILD_MAX_OLD_SPACE_MB: String(preparationChildOldSpaceMiB),
  });
  // NODE_ENV=test의 기본 inline 호환 모드가 아니라 실제 production fork factory를 쓴다.
  const createWithOptions = createContainer as unknown as (
    input: typeof config,
    options?: { preparationExecution: 'inline' | 'forked' },
  ) => Container;
  // 8ba3cff baseline의 1-argument factory는 두 번째 인자를 무시하므로 같은 script를
  // baseline worktree에도 복사해 inline 측정을 재현할 수 있다.
  let container: Container | null = createWithOptions(config, {
    preparationExecution: executionMode(argv),
  });
  const currentContainer = container;
  const passwordHash = await currentContainer.passwordHasher.hash(BENCHMARK_PASSWORD);
  currentContainer.userRepository.create({
    id: newId('usr'),
    username: BENCHMARK_USERNAME,
    passwordHash,
    totpSecret: null,
    totpEnabled: false,
    totpLastUsedStep: null,
    recoveryCodeHashes: [],
  }, currentContainer.clock.now());

  const app = await buildServer(currentContainer);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  sendMemorySample('idle-before-login');
  const memoryTimer = setInterval(() => sendMemorySample('periodic'), 1_000);
  memoryTimer.unref();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(memoryTimer);
    const appClosing = app.close();
    await container?.backtestPreparationOrchestrator.stop();
    await appClosing;
    await container?.close();
    container = null;
  };
  process.on('message', (message: unknown) => {
    if (message === 'shutdown') void close().finally(() => process.exit(0));
    if (message === 'sample-memory') sendMemorySample('requested');
  });
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.on('SIGINT', () => void close().finally(() => process.exit(0)));

  process.send?.({
    type: 'ready',
    address,
    username: BENCHMARK_USERNAME,
    password: BENCHMARK_PASSWORD,
  });
}

main().catch((error: unknown) => {
  process.send?.({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
