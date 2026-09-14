import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { AgentSettings } from './config.js';
import { DATABASE_SCHEMA_VERSION, datasetIdentity } from '../server/shared/db/database-layout.js';
import { type DatasetManifest } from '../shared/agent-protocol.js';

export function durableJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  const fd = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export class AgentDatasetCache {
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  current: DatasetManifest | null = null;
  constructor(readonly directory: string, private readonly settings: AgentSettings) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // 재시작 후에도 서버 명세의 해시로 로컬 파일을 확인한 뒤 계산에 사용한다.

  }
  file(dataset: DatasetManifest): string { return path.join(this.directory, `${dataset.version}-${dataset.sha256}.sqlite`); }
  get syncing(): boolean { return this.pending !== null; }

  async synchronize(manifest: DatasetManifest): Promise<void> {
    if (this.current && manifest.version < this.current.version) return;
    if (this.current?.version === manifest.version && this.current.sha256 === manifest.sha256) return;
    if (this.pending) { await this.pending; return this.synchronize(manifest); }
    this.pending = this.download(manifest).finally(() => { this.pending = null; this.abort = null; });
    return this.pending;
  }

  private async download(manifest: DatasetManifest): Promise<void> {
    if (manifest.schemaVersion !== DATABASE_SCHEMA_VERSION) throw new Error('계산 DB 스키마가 달라 클라이언트를 업데이트해야 합니다');
    const file = this.file(manifest);
    if (fs.existsSync(file)) {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      if (fs.statSync(file).size === manifest.bytes && hash.digest('hex') === manifest.sha256) {
        this.validate(file, manifest);
        this.current = manifest;
        return;
      }
    }
    const free = fs.statfsSync(this.directory);
    if (free.bavail * free.bsize < manifest.bytes * 1.1) throw new Error('계산 데이터 다운로드 공간이 부족합니다');
    const temporary = `${file}.part`;
    this.abort = new AbortController();
    try {
      const response = await fetch(`${this.settings.serverUrl}/api/agents/datasets/${manifest.version}`, {
        headers: { authorization: `Bearer ${this.settings.token}` }, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30 * 60_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`계산 데이터 다운로드 실패: HTTP ${response.status}`);
      let bytes = 0;
      const hash = createHash('sha256');
      const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > manifest.bytes) { callback(new Error('데이터 파일이 명세보다 큽니다')); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary, { mode: 0o600 }));
      if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new Error('계산 데이터 해시 또는 길이 불일치');
      this.validate(temporary, manifest);
      fs.chmodSync(temporary, 0o444);
      const fd = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      durableJson(path.join(this.directory, 'current.json'), manifest);
      this.current = manifest;
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  }

  private validate(file: string, manifest: DatasetManifest): void {
    const sqlite = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const identity = datasetIdentity(sqlite, 'main');
      if (identity.datasetId !== manifest.datasetId || identity.revision !== manifest.sourceRevision) throw new Error('계산 데이터 식별자 또는 버전 불일치');
      if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('계산 데이터 무결성 검사 실패');
      if (fs.statSync(file).mode & 0o222) fs.chmodSync(file, 0o444);
    } finally { sqlite.close(); }
  }

  prune(pinnedFiles: ReadonlySet<string>): void {
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^\d+-[a-f0-9]{64}\.sqlite$/.test(name)) continue;
      const file = path.join(this.directory, name);
      if (this.current && file === this.file(this.current) || pinnedFiles.has(file)) continue;
      fs.rmSync(file, { force: true });
    }
  }
  async stop(): Promise<void> { this.abort?.abort(); await this.pending?.catch(() => undefined); }
}
