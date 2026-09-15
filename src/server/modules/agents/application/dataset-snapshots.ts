import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DatabaseHandle } from '../../../../runtime/shared/db/database.js';
import { readRuntimeVersions } from '../../../../runtime/shared/runtime-versions.js';
import { DATABASE_SCHEMA_VERSION, datasetIdentity } from '../../../../runtime/shared/db/database-layout.js';
import { datasetManifestSchema, type DatasetManifest } from '../../../../shared/agent-protocol.js';

/** 준비가 끝난 파일만 latest에 게시한다. 작업별 입력 DB를 다시 구성하지 않는다. */
export class DatasetSnapshots {
  private publishing: Promise<DatasetManifest> | null = null;
  private child: ReturnType<typeof fork> | null = null;
  private stopped = false;
  private current: DatasetManifest | null;
  private readonly collectionVersion: string;

  constructor(private readonly database: DatabaseHandle, readonly directory: string, options?: { readonly collectionVersion: string }) {
    this.collectionVersion = options?.collectionVersion ?? readRuntimeVersions().collectionVersion;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'latest.json');
    this.current = this.readManifest(file);
    if (this.current && !fs.existsSync(this.file(this.current))) this.current = null;
  }

  latest(): DatasetManifest | null { return this.current; }

  file(manifest: DatasetManifest): string {
    return path.join(this.directory, `${manifest.version}-${manifest.sha256}.sqlite`);
  }

  get(version: number): DatasetManifest | null {
    const file = path.join(this.directory, `${version}.json`);
    return this.readManifest(file);
  }

  private readManifest(file: string): DatasetManifest | null {
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = datasetManifestSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      // 수집 버전을 모르는 과거 명세는 새 임대에 쓰지 않고 원본 DB에서 다시 게시한다.
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  ensureLatest(): Promise<DatasetManifest> {
    if (this.stopped) return Promise.reject(new Error('데이터 게시 서비스가 종료되었습니다'));
    if (this.publishing) return this.publishing;
    const source = datasetIdentity(this.database.sqlite);
    if (this.current?.datasetId === source.datasetId && this.current.sourceRevision === source.revision
      && this.current.schemaVersion === DATABASE_SCHEMA_VERSION
      && this.current.collectionVersion === this.collectionVersion) {
      return Promise.resolve(this.current);
    }
    // DB 복원으로 원본 revision이 낮아져도 배포 파일의 버전은 증가한다.
    const previousVersions = fs.readdirSync(this.directory).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number.parseInt(name, 10));
    const version = Math.max(this.current?.version ?? 0, ...previousVersions.filter(Number.isFinite)) + 1;
    this.publishing = this.publish(version).then((manifest) => {
      this.current = manifest;
      return manifest;
    }).finally(() => { this.publishing = null; });
    return this.publishing;
  }

  private publish(version: number): Promise<DatasetManifest> {
    const ts = import.meta.url.endsWith('.ts');
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL(`../../../../workers/dataset-publish-child.${ts ? 'ts' : 'js'}`, import.meta.url)), [], {
        execArgv: ts ? ['--import', 'tsx'] : [],
        env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      this.child = child;
      let result: DatasetManifest | null = null;
      let error = '';
      child.stderr?.on('data', (chunk: Buffer) => { if (error.length < 4000) error += chunk.toString(); });
      child.on('message', (message: unknown) => { result = datasetManifestSchema.parse(message); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        if (code === 0 && result) resolve(result);
        else reject(new Error(`계산 DB 게시 실패: ${error.trim()}`));
      });
      child.send({ sourcePath: this.database.dataPath, directory: this.directory, version, collectionVersion: this.collectionVersion });
    });
  }

  /** 현재와 직전 버전 및 아직 작업이 참조하는 버전만 보존한다. */
  prune(pinned: ReadonlySet<number>): void {
    if (!this.current || this.publishing) return;
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const version = Number.parseInt(name, 10);
      if (version >= this.current.version - 1 || pinned.has(version)) continue;
      const manifest = this.get(version);
      if (manifest) fs.rmSync(this.file(manifest), { force: true });
      else {
        // 구형 명세를 읽지 못해도 보존 대상이 아닌 해당 게시 파일은 함께 정리한다.
        const archive = new RegExp(`^${version}-[a-f0-9]{64}\\.sqlite$`);
        for (const file of fs.readdirSync(this.directory)) {
          if (archive.test(file)) fs.rmSync(path.join(this.directory, file), { force: true });
        }
      }
      fs.rmSync(path.join(this.directory, name), { force: true });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill('SIGTERM');
    await this.publishing?.catch(() => undefined);
  }
}
