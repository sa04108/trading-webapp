import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_BACKTEST_RESULT_ARTIFACT_BYTES } from './sqlite-backtest-result-artifact-importer.js';

export interface ReceivedResultArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  cleanup(): Promise<void>;
}

export class ResultArtifactUploadError extends Error {
  constructor(message: string, readonly statusCode: 400 | 413) {
    super(message);
    this.name = 'ResultArtifactUploadError';
  }
}

/** 업로드를 메모리에 모으지 않고 임시 파일로 받으면서 크기 상한과 SHA-256을 계산한다. */
export class RemoteResultUploadManager {
  constructor(private readonly tempRoot: string) {}

  /** app 부팅 전, 재시작으로 끊겨 재개할 수 없는 upload 조각만 정리한다. */
  cleanupOrphanedUploads(): Promise<void> {
    return fs.rm(path.join(this.tempRoot, 'remote-backtests', 'uploads'), {
      recursive: true,
      force: true,
    });
  }

  async receive(source: Readable, jobId: string, attempt: number): Promise<ReceivedResultArtifact> {
    if (!/^[a-zA-Z0-9_-]{3,128}$/.test(jobId) || !Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new ResultArtifactUploadError('결과 artifact 경로 식별자가 올바르지 않습니다', 400);
    }
    const directory = path.join(
      this.tempRoot,
      'remote-backtests',
      'uploads',
      `${jobId}-${attempt}-${randomUUID()}`,
    );
    const artifactPath = path.join(directory, 'result.sqlite');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_BACKTEST_RESULT_ARTIFACT_BYTES) {
          callback(new ResultArtifactUploadError('결과 artifact가 업로드 상한을 넘습니다', 413));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, limiter, createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 }));
      if (size === 0) throw new ResultArtifactUploadError('빈 결과 artifact입니다', 400);
      return {
        path: artifactPath,
        sha256: hash.digest('hex'),
        size,
        cleanup: () => fs.rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
