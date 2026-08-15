import { fork } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface RemoteInputBundle {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 입력 snapshot 생성을 웹 이벤트 루프 밖의 자식 프로세스에서 수행하고 attempt별로 캐시한다. */
export class RemoteInputBundleManager {
  private readonly inFlight = new Map<string, Promise<RemoteInputBundle>>();
  private generationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly sourceDatabasePath: string,
    private readonly tempRoot: string,
  ) {}

  prepare(jobId: string, attempt: number): Promise<RemoteInputBundle> {
    const key = `${jobId}:${attempt}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    // $7 Lightsail에서 여러 worker slot이 동시에 claim해도 운영 DB snapshot copy는 한 번에
    // 하나만 수행한다. 계산 병렬도와 control plane의 디스크 작업 병렬도를 분리한다.
    const promise = this.generationTail
      .then(() => this.prepareOnce(jobId, attempt))
      .finally(() => this.inFlight.delete(key));
    this.generationTail = promise.then(() => undefined, () => undefined);
    this.inFlight.set(key, promise);
    return promise;
  }

  async removeJob(jobId: string): Promise<void> {
    await fs.rm(this.jobRoot(jobId), { recursive: true, force: true });
  }

  private async prepareOnce(jobId: string, attempt: number): Promise<RemoteInputBundle> {
    const jobRoot = this.jobRoot(jobId);
    const directory = path.join(jobRoot, String(attempt));
    const bundlePath = path.join(directory, 'input.sqlite');
    await this.removeOtherAttempts(jobRoot, attempt);
    try {
      const stat = await fs.stat(bundlePath);
      return { path: bundlePath, size: stat.size, sha256: await sha256File(bundlePath) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const staleFiles = await fs.readdir(directory);
    await Promise.all(staleFiles
      .filter((entry) => entry.startsWith('input.sqlite.') && entry.endsWith('.partial'))
      .map((entry) => fs.rm(path.join(directory, entry), { force: true })));
    const partialPath = `${bundlePath}.${randomUUID()}.partial`;

    const isTsRuntime = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(
      `../../../../workers/backtest-input-bundle-child.${isTsRuntime ? 'ts' : 'js'}`,
      import.meta.url,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const child = fork(fileURLToPath(workerUrl), [jobId], {
          env: {
            NODE_ENV: process.env.NODE_ENV ?? 'production',
            SOURCE_DATABASE_PATH: this.sourceDatabasePath,
            BUNDLE_PATH: partialPath,
            BACKTEST_JOB_ID: jobId,
          },
          execArgv: isTsRuntime ? ['--import', 'tsx'] : [],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 8_000) stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(
            `입력 bundle 생성 실패 (code=${code}, signal=${signal ?? 'none'}): ${stderr.trim()}`,
          ));
        });
      });
      await fs.rename(partialPath, bundlePath);
    } catch (error) {
      await fs.rm(partialPath, { force: true });
      throw error;
    }

    const stat = await fs.stat(bundlePath);
    return { path: bundlePath, size: stat.size, sha256: await sha256File(bundlePath) };
  }

  private jobRoot(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]{3,128}$/.test(jobId)) throw new Error('올바르지 않은 backtest job id');
    return path.join(this.tempRoot, 'remote-backtests', jobId);
  }

  private async removeOtherAttempts(jobRoot: string, currentAttempt: number): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(jobRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => /^\d+$/.test(entry) && entry !== String(currentAttempt))
      .map((entry) => fs.rm(path.join(jobRoot, entry), { recursive: true, force: true })));
  }
}
