import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  DEFAULT_BENCHMARK_REQUEST,
  createDisposableDatabase,
  parseBenchmarkOptions,
  readInventory,
  semanticPreviewHash,
  summarizeSamples,
  type BenchmarkOptions,
  type BenchmarkReport,
  type JobRunReport,
  type ParentMemorySummary,
} from './universe-benchmark-common.js';
import {
  SYNTHETIC_FIXTURE_VERSION,
  seedSyntheticBenchmark,
} from './universe-benchmark-synthetic.js';

const HTTP_TIMEOUT_MS = 5_000;

interface ServerReadyMessage {
  readonly type: 'ready';
  readonly address: string;
  readonly username: string;
  readonly password: string;
}

interface PreparationSnapshot {
  readonly status: string;
  readonly phase: string;
  readonly error?: string | null;
}

interface MemoryMessage {
  readonly type: 'memory';
  readonly label: string;
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly pssBytes: number;
  readonly pssAnonBytes: number;
  readonly pssFileBytes: number;
}

interface RunResult {
  readonly report: JobRunReport;
  readonly responseBody: Record<string, unknown> | null;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function benchmarkFetch(
  input: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function cookieFrom(response: Response): string {
  const values = response.headers.getSetCookie();
  const cookie = values[0]?.split(';')[0];
  if (!cookie) throw new Error('benchmark login 응답에 session cookie가 없습니다.');
  return cookie;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`HTTP ${response.status} 응답이 JSON object가 아닙니다.`);
  }
  return body as Record<string, unknown>;
}

function processChildren(pid: number): number[] {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return raw === '' ? [] : raw.split(/\s+/).map(Number).filter(Number.isSafeInteger);
  } catch {
    return [];
  }
}

function processTreePids(rootPid: number): number[] {
  const result: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    queue.push(...processChildren(pid));
  }
  return result;
}

function rssBytes(pid: number): number {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function smapsPss(pid: number): { pss: number; anon: number; file: number } {
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kib = (name: string): number => Number(
      new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(rollup)?.[1] ?? 0,
    );
    return { pss: kib('Pss') * 1024, anon: kib('Pss_Anon') * 1024, file: kib('Pss_File') * 1024 };
  } catch {
    return { pss: 0, anon: 0, file: 0 };
  }
}

function emptyParentMemorySummary(): ParentMemorySummary {
  return {
    samples: 0, maxRssBytes: 0, maxHeapUsedBytes: 0, maxHeapTotalBytes: 0,
    maxExternalBytes: 0, maxArrayBuffersBytes: 0, maxPssBytes: 0,
    maxPssAnonBytes: 0, maxPssFileBytes: 0,
  };
}

function processStartMarker(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function processGroupId(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[2]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberProcess(processes: Map<number, string>, pid: number): void {
  const marker = processStartMarker(pid);
  if (marker !== null && !processes.has(pid)) processes.set(pid, marker);
}

function sameObservedProcess(pid: number, marker: string): boolean {
  return processStartMarker(pid) === marker;
}

function hasObservedProcess(processes: Map<number, string>): boolean {
  return [...processes].some(([pid, marker]) => sameObservedProcess(pid, marker));
}

function hasObservedProcessInGroup(processes: Map<number, string>, groupId: number): boolean {
  return [...processes].some(([pid, marker]) => (
    sameObservedProcess(pid, marker) && processGroupId(pid) === groupId
  ));
}

async function terminateTree(child: ChildProcess, observedPids: Map<number, string>): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  const originalRootMarker = observedPids.get(pid);
  if (originalRootMarker !== undefined && sameObservedProcess(pid, originalRootMarker)) {
    for (const current of processTreePids(pid)) rememberProcess(observedPids, current);
  }
  if (hasObservedProcessInGroup(observedPids, pid)) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* process group already exited */ }
  }
  for (const [descendant, marker] of [...observedPids].reverse()) {
    if (!sameObservedProcess(descendant, marker)) continue;
    try { process.kill(descendant, 'SIGTERM'); } catch { /* process already exited */ }
  }
  await delay(1_000);
  if (originalRootMarker !== undefined && sameObservedProcess(pid, originalRootMarker)) {
    for (const current of processTreePids(pid)) rememberProcess(observedPids, current);
  }
  if (hasObservedProcessInGroup(observedPids, pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* process group already exited */ }
  }
  for (const [descendant, marker] of [...observedPids].reverse()) {
    if (!sameObservedProcess(descendant, marker)) continue;
    try { process.kill(descendant, 'SIGKILL'); } catch { /* process already exited */ }
  }
  const deadline = Date.now() + 2_000;
  while (
    [...observedPids].some(([observed, marker]) => sameObservedProcess(observed, marker))
    && Date.now() < deadline
  ) await delay(25);
  return !hasObservedProcess(observedPids);
}

async function waitForServer(child: ChildProcess, timeoutMs: number): Promise<ServerReadyMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('benchmark server 시작 timeout')), timeoutMs);
    const onMessage = (message: unknown): void => {
      if (typeof message !== 'object' || message === null) return;
      const candidate = message as Record<string, unknown>;
      if (candidate.type === 'fatal') {
        clearTimeout(timer);
        reject(new Error(
          typeof candidate.message === 'string' ? candidate.message : 'benchmark server가 실패했습니다.',
        ));
      }
      if (
        candidate.type === 'ready'
        && typeof candidate.address === 'string'
        && typeof candidate.username === 'string'
        && typeof candidate.password === 'string'
      ) {
        clearTimeout(timer);
        child.off('message', onMessage);
        resolve(candidate as unknown as ServerReadyMessage);
      }
    };
    child.on('message', onMessage);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`benchmark server가 준비 전에 종료했습니다 (code=${code ?? 'signal'}).`));
    });
  });
}

async function login(server: ServerReadyMessage): Promise<string> {
  const response = await benchmarkFetch(`${server.address}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: server.username, password: server.password }),
  });
  if (response.status !== 200) throw new Error(`benchmark login 실패: HTTP ${response.status}`);
  return cookieFrom(response);
}

async function readinessMonitor(
  address: string,
  intervalMs: number,
  stopped: () => boolean,
): Promise<{ latencies: number[]; gaps: number[]; failures: number }> {
  const latencies: number[] = [];
  const gaps: number[] = [];
  let failures = 0;
  let previousCompletedAt = nowMs();
  while (!stopped()) {
    const started = nowMs();
    try {
      const response = await benchmarkFetch(`${address}/api/v1/health/ready`);
      const completed = nowMs();
      latencies.push(completed - started);
      gaps.push(completed - previousCompletedAt);
      previousCompletedAt = completed;
      if (response.status !== 200) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    }
    if (!stopped()) await delay(intervalMs);
  }
  return { latencies, gaps, failures };
}

async function consumeSse(
  address: string,
  cookie: string,
  jobId: string,
  abort: AbortController,
  onSnapshot: (snapshot: PreparationSnapshot, atMs: number) => void,
): Promise<{ openLatencyMs: number | null; events: number }> {
  const started = nowMs();
  let response: Response;
  try {
    const openAbort = new AbortController();
    const abortOpen = (): void => openAbort.abort();
    abort.signal.addEventListener('abort', abortOpen, { once: true });
    const openTimeout = setTimeout(abortOpen, HTTP_TIMEOUT_MS);
    try {
      response = await fetch(`${address}/api/v1/backtests/preparation-jobs/${jobId}/events`, {
        headers: { cookie }, signal: openAbort.signal,
      });
    } finally {
      clearTimeout(openTimeout);
    }
  } catch {
    return { openLatencyMs: null, events: 0 };
  }
  const openLatencyMs = nowMs() - started;
  if (response.status !== 200 || response.body === null) return { openLatencyMs, events: 0 };
  const decoder = new TextDecoder();
  let buffer = '';
  let events = 0;
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
        if (!data) continue;
        const parsed = JSON.parse(data) as { job?: PreparationSnapshot } & PreparationSnapshot;
        const snapshot = parsed.job ?? parsed;
        if (typeof snapshot.status !== 'string' || typeof snapshot.phase !== 'string') continue;
        events += 1;
        onSnapshot(snapshot, nowMs());
      }
    }
  } catch {
    // terminal 시 controller가 stream을 abort하는 정상 종료도 이 경로다.
  }
  return { openLatencyMs, events };
}

async function getJob(address: string, cookie: string, jobId: string): Promise<PreparationSnapshot> {
  const response = await benchmarkFetch(`${address}/api/v1/backtests/preparation-jobs/${jobId}`, {
    headers: { cookie },
  });
  if (response.status !== 200) throw new Error(`preparation GET 실패: HTTP ${response.status}`);
  const body = await jsonResponse(response);
  return body.job as PreparationSnapshot;
}

async function runJob(
  server: ServerReadyMessage,
  cookie: string,
  options: BenchmarkOptions,
  cancel: boolean,
  preparationChildActive: () => boolean,
  onPreparationSnapshot: (snapshot: PreparationSnapshot) => void,
): Promise<RunResult> {
  const started = nowMs();
  const response = await benchmarkFetch(`${server.address}/api/v1/backtests/universe-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(DEFAULT_BENCHMARK_REQUEST),
  }, Math.min(options.timeoutMs, 120_000));
  const startLatencyMs = nowMs() - started;
  const startBody = await jsonResponse(response);
  if (response.status === 200) {
    return {
      responseBody: startBody,
      report: {
        startStatus: 200, startLatencyMs, terminalStatus: 'COMPLETED', terminalError: null,
        runningObserved: false, resolvingStagesObserved: false, preparationChildObserved: false,
        totalMs: nowMs() - started,
        cancelRequestLatencyMs: null, cancelStatus: null, sseOpenLatencyMs: null, sseEvents: 0,
        phaseDurationsMs: {},
      },
    };
  }
  if (response.status !== 202) {
    throw new Error(`preview 시작 실패: HTTP ${response.status} ${JSON.stringify(startBody)}`);
  }
  const job = startBody.job as { id?: unknown; status?: unknown; phase?: unknown } | undefined;
  if (!job || typeof job.id !== 'string') throw new Error('202 응답에 preparation job id가 없습니다.');
  const jobId = job.id;
  if (typeof job.status === 'string' && typeof job.phase === 'string') {
    onPreparationSnapshot({ status: job.status, phase: job.phase });
  }
  let terminal = false;
  const phaseDurations: Record<string, number> = {};
  let currentPhase = typeof job.phase === 'string' ? job.phase : null;
  let currentPhaseAt = nowMs();
  const observe = (snapshot: PreparationSnapshot, atMs: number): void => {
    onPreparationSnapshot(snapshot);
    if (snapshot.phase !== currentPhase) {
      if (currentPhase !== null) phaseDurations[currentPhase] = (phaseDurations[currentPhase] ?? 0) + atMs - currentPhaseAt;
      currentPhase = snapshot.phase;
      currentPhaseAt = atMs;
    }
  };

  const sseAbort = new AbortController();
  const sse = consumeSse(server.address, cookie, jobId, sseAbort, observe);
  let cancelRequestLatencyMs: number | null = null;
  let cancelStatus: number | null = null;
  let cancellation: Promise<void> | null = null;
  let runningObserved = false;
  let resolvingStagesObserved = false;
  let preparationChildObserved = false;

  let terminalSnapshot: PreparationSnapshot;
  for (;;) {
    const snapshot = await getJob(server.address, cookie, jobId);
    observe(snapshot, nowMs());
    if (snapshot.status === 'RUNNING') {
      runningObserved = true;
      if (snapshot.phase === 'RESOLVING_STAGES') resolvingStagesObserved = true;
      if (preparationChildActive()) preparationChildObserved = true;
      if (
        cancel && cancellation === null && resolvingStagesObserved && preparationChildObserved
      ) {
        cancellation = (async () => {
          await delay(options.cancelAfterMs);
          if (terminal) return;
          const cancelStarted = nowMs();
          const cancelResponse = await benchmarkFetch(
            `${server.address}/api/v1/backtests/preparation-jobs/${jobId}/cancel`,
            { method: 'POST', headers: { cookie } },
          );
          cancelRequestLatencyMs = nowMs() - cancelStarted;
          cancelStatus = cancelResponse.status;
          await cancelResponse.arrayBuffer();
        })();
      }
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(snapshot.status)) {
      terminalSnapshot = snapshot;
      break;
    }
    await delay(50);
  }
  terminal = true;
  await cancellation;
  const terminalAt = nowMs();
  if (currentPhase !== null) phaseDurations[currentPhase] = (phaseDurations[currentPhase] ?? 0) + terminalAt - currentPhaseAt;
  sseAbort.abort();
  const sseResult = await sse;

  let responseBody: Record<string, unknown> | null = null;
  if (terminalSnapshot?.status === 'COMPLETED') {
    const replay = await benchmarkFetch(`${server.address}/api/v1/backtests/universe-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(DEFAULT_BENCHMARK_REQUEST),
    }, Math.min(options.timeoutMs, 120_000));
    if (replay.status === 200) responseBody = await jsonResponse(replay);
    else await replay.arrayBuffer();
  }
  return {
    responseBody,
    report: {
      startStatus: response.status,
      startLatencyMs,
      terminalStatus: terminalSnapshot.status,
      terminalError: terminalSnapshot.error ?? null,
      runningObserved,
      resolvingStagesObserved,
      preparationChildObserved,
      totalMs: terminalAt - started,
      cancelRequestLatencyMs,
      cancelStatus,
      sseOpenLatencyMs: sseResult.openLatencyMs,
      sseEvents: sseResult.events,
      phaseDurationsMs: phaseDurations,
    },
  };
}

function repositoryIdentity(): BenchmarkReport['repository'] {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const diff = execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync(
    'git', ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString('utf8').split('\0').filter(Boolean).sort();
  const fingerprint = createHash('sha256').update(diff).update(status);
  for (const relative of untracked) {
    const absolute = path.resolve(repositoryRoot, relative);
    if (!absolute.startsWith(`${repositoryRoot}${path.sep}`)) continue;
    const stat = fs.lstatSync(absolute);
    fingerprint.update(relative).update('\0');
    if (stat.isFile()) fingerprint.update(fs.readFileSync(absolute));
  }
  return {
    gitSha,
    dirty: status.length > 0,
    diffFingerprint: fingerprint.digest('hex'),
  };
}

function isExternalDataFailure(reason: string, synthetic: boolean): boolean {
  return !synthetic && /(DART|KRX|fetch|ECONN|coverage|covered|누락|데이터)/i.test(reason);
}

async function execute(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const disposable = await createDisposableDatabase(options.databasePath);
  let child: ChildProcess | null = null;
  let stage = options.syntheticSymbols === null ? 'STARTING_SERVER' : 'SEEDING_SYNTHETIC_FIXTURE';
  let cancelledRun: JobRunReport | null = null;
  let completedRun: JobRunReport | null = null;
  let readyReplayLatencyMs: number | null = null;
  let result: BenchmarkReport['result'] = null;
  let readinessStopped = false;
  let readinessPromise: ReturnType<typeof readinessMonitor> | null = null;
  let readiness = summarizeSamples([], [], 0);
  let maxProcessTreeRssBytes = 0;
  let maxServerRssBytes = 0;
  let maxPreparationDescendantsRssBytes = 0;
  let maxProcessTreeCount = 0;
  let maxProcessTreePssBytes = 0;
  let maxProcessTreePssAnonBytes = 0;
  let maxProcessTreePssFileBytes = 0;
  const parentMemoryByStage: Record<string, ParentMemorySummary> = {};
  let lastPreparationStatus: string | null = null;
  let lastPreparationPhase: string | null = null;
  let monitorError: Error | null = null;
  let inventory!: BenchmarkReport['inventory'];
  let workingDatabaseBytes!: number;
  const observedPids = new Map<number, string>();
  let stderr = '';
  let cleanupFailed = false;

  // synthetic fixture만 실제 FactSyncService의 freshness 경로에서 결정적 DART 013을
  // 받는다. 실제 snapshot은 loopback deny로 끝나 NEEDS_DATA와 성능 실패를 구분한다.
  const dartServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: '013', message: 'benchmark no data' }));
  });
  let dartBaseUrl = 'http://127.0.0.1:9';
  try {
    if (options.syntheticSymbols !== null) {
      await new Promise<void>((resolve, reject) => {
        dartServer.once('error', reject);
        dartServer.listen(0, '127.0.0.1', () => resolve());
      });
      const dartAddress = dartServer.address() as AddressInfo;
      dartBaseUrl = `http://127.0.0.1:${dartAddress.port}`;
      seedSyntheticBenchmark(disposable.databasePath, options.syntheticSymbols);
    }
    workingDatabaseBytes = fs.statSync(disposable.databasePath).size;
    const inventoryDb = new Database(disposable.databasePath, { readonly: true, fileMustExist: true });
    inventory = readInventory(inventoryDb);
    inventoryDb.close();

    stage = 'STARTING_SERVER';
    const serverEntry = fileURLToPath(new URL('./universe-benchmark-server.ts', import.meta.url));
    const childArgs = [
      '--database', disposable.databasePath,
      '--execution', options.execution,
      '--dart-base-url', dartBaseUrl,
      '--preparation-child-max-rss-mib', String(options.preparationChildMaxRssMiB),
      '--preparation-child-old-space-mib', String(options.preparationChildOldSpaceMiB),
      ...(options.syntheticSymbols === null ? [] : ['--synthetic']),
      ...(options.serverRuntime === 'built' ? ['--built'] : []),
    ];
    child = fork(serverEntry, childArgs, {
      // Node 24 native type stripping only loads this thin TS wrapper; both app and worker
      // come from dist JS. Source mode retains the parent CLI's tsx loader.
      execArgv: options.serverRuntime === 'built' ? [] : process.execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    });
    if (child.pid !== undefined) rememberProcess(observedPids, child.pid);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-32_768);
    });
    child.on('message', (raw: unknown) => {
      if (raw === null || typeof raw !== 'object') return;
      const message = raw as Partial<MemoryMessage>;
      if (message.type !== 'memory' || typeof message.rss !== 'number') return;
      const bucket = message.label === 'idle-before-login' ? message.label : stage;
      const previous = parentMemoryByStage[bucket] ?? emptyParentMemorySummary();
      parentMemoryByStage[bucket] = {
        samples: previous.samples + 1,
        maxRssBytes: Math.max(previous.maxRssBytes, message.rss),
        maxHeapUsedBytes: Math.max(previous.maxHeapUsedBytes, message.heapUsed ?? 0),
        maxHeapTotalBytes: Math.max(previous.maxHeapTotalBytes, message.heapTotal ?? 0),
        maxExternalBytes: Math.max(previous.maxExternalBytes, message.external ?? 0),
        maxArrayBuffersBytes: Math.max(previous.maxArrayBuffersBytes, message.arrayBuffers ?? 0),
        maxPssBytes: Math.max(previous.maxPssBytes, message.pssBytes ?? 0),
        maxPssAnonBytes: Math.max(previous.maxPssAnonBytes, message.pssAnonBytes ?? 0),
        maxPssFileBytes: Math.max(previous.maxPssFileBytes, message.pssFileBytes ?? 0),
      };
    });
    // 서버 로그는 결과에 섞지 않되 pipe backpressure로 서버가 멈추지 않게 비운다.
    child.stdout?.resume();
    let nextPssSampleAt = 0;
    const monitor = setInterval(() => {
      if (child?.pid === undefined) return;
      const rootMarker = observedPids.get(child.pid);
      if (rootMarker === undefined || !sameObservedProcess(child.pid, rootMarker)) return;
      const tree = processTreePids(child.pid);
      for (const pid of tree) rememberProcess(observedPids, pid);
      maxProcessTreeCount = Math.max(maxProcessTreeCount, tree.length);
      const serverRss = rssBytes(child.pid);
      const descendantRss = tree
        .filter((pid) => pid !== child?.pid)
        .reduce((sum, pid) => sum + rssBytes(pid), 0);
      const total = serverRss + descendantRss;
      maxProcessTreeRssBytes = Math.max(maxProcessTreeRssBytes, total);
      maxServerRssBytes = Math.max(maxServerRssBytes, serverRss);
      maxPreparationDescendantsRssBytes = Math.max(
        maxPreparationDescendantsRssBytes, descendantRss,
      );
      if (Date.now() >= nextPssSampleAt) {
        nextPssSampleAt = Date.now() + 1_000;
        const pss = tree.map(smapsPss).reduce(
          (sum, sample) => ({
            pss: sum.pss + sample.pss,
            anon: sum.anon + sample.anon,
            file: sum.file + sample.file,
          }),
          { pss: 0, anon: 0, file: 0 },
        );
        maxProcessTreePssBytes = Math.max(maxProcessTreePssBytes, pss.pss);
        maxProcessTreePssAnonBytes = Math.max(maxProcessTreePssAnonBytes, pss.anon);
        maxProcessTreePssFileBytes = Math.max(maxProcessTreePssFileBytes, pss.file);
      }
      if (total > options.memoryLimitMiB * 1024 ** 2 && monitorError === null) {
        monitorError = new Error(
          `process tree RSS ${Math.round(total / 1024 ** 2)}MiB가 상한 ${options.memoryLimitMiB}MiB를 넘었습니다.`,
        );
        void terminateTree(child, observedPids);
      }
    }, 25);
    const timeout = setTimeout(() => {
      if (monitorError === null) monitorError = new Error(`전체 timeout ${options.timeoutMs}ms를 넘었습니다.`);
      if (child) void terminateTree(child, observedPids);
    }, options.timeoutMs);

    try {
      const server = await waitForServer(child, Math.min(options.timeoutMs, 60_000));
      const cookie = await login(server);
      stage = 'AFTER_LOGIN';
      if (child.connected) child.send('sample-memory', () => undefined);
      await delay(10);
      readinessPromise = readinessMonitor(
        server.address, options.heartbeatIntervalMs, () => readinessStopped,
      );
      const preparationChildActive = (): boolean => child?.pid !== undefined
        && processTreePids(child.pid).length >= 2;
      const onPreparationSnapshot = (snapshot: PreparationSnapshot): void => {
        lastPreparationStatus = snapshot.status;
        lastPreparationPhase = snapshot.phase;
      };
      let completed: RunResult;
      if (options.execution === 'forked') {
        stage = 'CANCELLATION_RUN';
        const cancelled = await runJob(
          server, cookie, options, true, preparationChildActive, onPreparationSnapshot,
        );
        cancelledRun = cancelled.report;
        if (monitorError) throw monitorError;
        if (
          cancelled.report.terminalStatus !== 'CANCELLED'
          || !cancelled.report.runningObserved
          || !cancelled.report.resolvingStagesObserved
          || !cancelled.report.preparationChildObserved
          || cancelled.report.cancelStatus !== 200
        ) {
          throw new Error(
            '취소 측정이 RUNNING/RESOLVING_STAGES 실제 child 진입 후 CANCELLED로 끝나지 않았습니다. '
            + `terminal=${cancelled.report.terminalStatus ?? 'UNKNOWN'}, cancelHttp=`
            + `${cancelled.report.cancelStatus ?? 'NONE'}`,
          );
        }
        stage = 'COMPLETION_RUN';
        completed = await runJob(
          server, cookie, options, false, preparationChildActive, onPreparationSnapshot,
        );
      } else {
        stage = 'INLINE_COMPLETION_RUN';
        completed = await runJob(
          server, cookie, options, false, preparationChildActive, onPreparationSnapshot,
        );
      }
      completedRun = completed.report;
      if (monitorError) throw monitorError;
      if (completed.report.terminalStatus !== 'COMPLETED' || completed.responseBody === null) {
        throw new Error(
          `완료 측정이 ${completed.report.terminalStatus ?? 'UNKNOWN'}로 끝났습니다: `
          + `${completed.report.terminalError ?? '원인 미상'}. `
          + 'snapshot의 market/facts/coverage 준비 상태를 확인하세요.',
        );
      }
      if (options.execution === 'forked' && maxProcessTreeCount < 2) {
        throw new Error('forked 측정 중 preparation child process가 관찰되지 않았습니다.');
      }
      stage = 'READY_REVALIDATION';
      const replayStarted = nowMs();
      const replay = await benchmarkFetch(`${server.address}/api/v1/backtests/universe-preview`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(DEFAULT_BENCHMARK_REQUEST),
      }, Math.min(options.timeoutMs, 120_000));
      readyReplayLatencyMs = nowMs() - replayStarted;
      const replayBody = await jsonResponse(replay);
      if (replay.status !== 200) throw new Error(`READY replay 실패: HTTP ${replay.status}`);
      const schedule = replayBody.schedule as unknown[];
      const diagnostics = replayBody.diagnostics as unknown[];
      const unionSymbols = replayBody.unionSymbols as unknown[];
      const warnings = replayBody.warnings as unknown[];
      result = {
        scheduleHash: String(replayBody.scheduleHash ?? ''),
        scheduleEntries: Array.isArray(schedule) ? schedule.length : 0,
        unionSymbols: Array.isArray(unionSymbols) ? unionSymbols.length : 0,
        diagnosticEntries: Array.isArray(diagnostics) ? diagnostics.length : 0,
        warnings: Array.isArray(warnings) ? warnings.length : 0,
        semanticHash: semanticPreviewHash(replayBody),
      };
      stage = 'COMPLETED';
    } catch (error) {
      const detail = stderr.trim();
      const failure = monitorError ?? error;
      const cause = failure instanceof Error && failure.cause instanceof Error
        ? ` (${failure.cause.message})`
        : '';
      const reason = `${failure instanceof Error ? failure.message : String(failure)}${cause}`
        + `${detail ? `\nserver stderr:\n${detail}` : ''}`;
      stage = `${stage}: ${reason}`;
    } finally {
      readinessStopped = true;
      if (readinessPromise !== null) {
        const samples = await readinessPromise;
        readiness = summarizeSamples(samples.latencies, samples.gaps, samples.failures);
        if (
          stage === 'COMPLETED'
          && (
            readiness.requests === 0
            || readiness.failures > 0
            || readiness.maxLatencyMs === null
            || readiness.maxLatencyMs > options.readinessMaxLatencyMs
            || readiness.p95LatencyMs === null
            || readiness.p95LatencyMs > options.readinessP95LatencyMs
          )
        ) {
          stage = 'READINESS_BUDGET: readiness heartbeat가 성공 기준을 넘었습니다. '
            + `requests=${readiness.requests}, failures=${readiness.failures}, `
            + `max=${String(readiness.maxLatencyMs)}ms/${options.readinessMaxLatencyMs}ms, `
            + `p95=${String(readiness.p95LatencyMs)}ms/${options.readinessP95LatencyMs}ms`;
        }
      }
      clearInterval(monitor);
      clearTimeout(timeout);
      if (child.connected) child.send('shutdown', () => undefined);
      const exited = new Promise<void>((resolve) => {
        if (child?.exitCode !== null || child?.signalCode !== null) resolve();
        else child?.once('exit', () => resolve());
      });
      await Promise.race([exited, delay(2_000)]);
      if (
        (child.exitCode === null && child.signalCode === null)
        || hasObservedProcess(observedPids)
      ) {
        cleanupFailed = !(await terminateTree(child, observedPids));
        if (cleanupFailed) {
          stage = `CLEANUP_FAILED: ${stage}; original benchmark process가 종료되지 않았습니다.`;
        }
      }
    }
  } finally {
    if (dartServer.listening) {
      await new Promise<void>((resolve) => dartServer.close(() => resolve()));
    }
    if (!options.keepTemp && !cleanupFailed) fs.rmSync(disposable.dir, { recursive: true, force: true });
    else console.error(`disposable benchmark DB retained: ${disposable.dir}`);
  }

  const failureReason = stage === 'COMPLETED' ? null : stage;
  const sourceIdentity = {
    sourceSha256: disposable.sourceSha256,
    syntheticSymbols: options.syntheticSymbols,
    fixtureVersion: options.syntheticSymbols === null ? null : SYNTHETIC_FIXTURE_VERSION,
    request: DEFAULT_BENCHMARK_REQUEST,
  };
  const report: BenchmarkReport = {
    schemaVersion: 2,
    status: failureReason === null ? 'COMPLETED' : 'FAILED',
    repository: repositoryIdentity(),
    request: DEFAULT_BENCHMARK_REQUEST,
    source: {
      databaseBytes: disposable.sourceBytes,
      workingDatabaseBytes,
      inputFingerprint: createHash('sha256').update(JSON.stringify(sourceIdentity)).digest('hex'),
      sourceSha256: disposable.sourceSha256,
      fixtureVersion: options.syntheticSymbols === null ? null : SYNTHETIC_FIXTURE_VERSION,
      syntheticSymbols: options.syntheticSymbols,
      execution: options.execution,
      serverRuntime: options.serverRuntime,
      memoryLimitMiB: options.memoryLimitMiB,
      preparationChildMaxRssMiB: options.preparationChildMaxRssMiB,
      preparationChildOldSpaceMiB: options.preparationChildOldSpaceMiB,
      readinessMaxLatencyMs: options.readinessMaxLatencyMs,
      readinessP95LatencyMs: options.readinessP95LatencyMs,
    },
    inventory,
    cancelledRun,
    completedRun,
    readyReplayLatencyMs,
    readiness,
    maxProcessTreeRssBytes,
    maxServerRssBytes,
    maxPreparationDescendantsRssBytes,
    maxProcessTreePssBytes,
    maxProcessTreePssAnonBytes,
    maxProcessTreePssFileBytes,
    parentMemoryByStage,
    maxProcessTreeCount,
    result,
    failure: failureReason === null ? null : {
      stage: failureReason.split(':', 1)[0] ?? 'UNKNOWN',
      reason: failureReason,
      externalDataRequired: isExternalDataFailure(
        failureReason, options.syntheticSymbols !== null,
      ),
      lastPreparationStatus,
      lastPreparationPhase,
    },
  };
  if (options.comparePath === null || result === null) return report;
  const compared = JSON.parse(fs.readFileSync(options.comparePath, 'utf8')) as BenchmarkReport;
  return {
    ...report,
    comparison: {
      reportPath: options.comparePath,
      scheduleHashEqual: compared.result?.scheduleHash === result.scheduleHash,
      semanticHashEqual: compared.result?.semanticHash === result.semanticHash,
      inputFingerprintEqual: compared.source.inputFingerprint === report.source.inputFingerprint,
      fixtureEqual: compared.source.fixtureVersion === report.source.fixtureVersion,
      requestEqual: JSON.stringify(compared.request) === JSON.stringify(report.request),
    },
  };
}

export async function runUniverseBenchmarkCli(argv: readonly string[]): Promise<void> {
  const options = parseBenchmarkOptions(argv);
  const report = await execute(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath !== null) fs.writeFileSync(options.outputPath, serialized, { mode: 0o600 });
  process.stdout.write(serialized);
  if (report.status === 'FAILED') throw new Error(report.failure?.reason ?? 'benchmark failed');
  if (report.comparison && (
    !report.comparison.scheduleHashEqual
    || !report.comparison.semanticHashEqual
    || !report.comparison.inputFingerprintEqual
    || !report.comparison.fixtureEqual
    || !report.comparison.requestEqual
  )) {
    throw new Error('baseline/proposed preview semantics가 일치하지 않습니다.');
  }
}
