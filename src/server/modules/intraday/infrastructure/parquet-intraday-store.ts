import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { BoundedIntradayCache } from "../application/intraday-cache.js";
import {
  INTRADAY_RETENTION_DAYS,
  intradayBarSchema,
  intradaySymbolSchema,
  type IntradayBar,
  type IntradaySymbolData,
} from "../../../../shared/schemas/intraday.js";

type Entry = { month: string; file: string; sha256: string };
type Manifest = IntradaySymbolData & { version: 1; files: Entry[] };
const locks = new Map<string, Promise<void>>();
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const fields = ["endMs", "open", "high", "low", "close", "volume"] as const;
const revision = (files: Entry[]) => hash(JSON.stringify(files));
const monthOf = (endMs: number) =>
  new Date(endMs + 9 * 3_600_000).toISOString().slice(0, 7);

export class ParquetIntradayStore {
  private readonly root: string;
  private readonly decoded = new BoundedIntradayCache<readonly IntradayBar[]>(500_000, 128);
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private async gate<T>(action: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(this.root, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(this.root) === current) locks.delete(this.root);
    }
  }
  private dir(symbol: string): string {
    return path.join(this.root, intradaySymbolSchema.parse(symbol));
  }
  private async manifest(symbol: string): Promise<Manifest | null> {
    const dir = this.dir(symbol);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.access(dir);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw inner;
      }
      throw new Error(`분봉 manifest가 없습니다: ${symbol}`, { cause: error });
    }
    const m = JSON.parse(raw) as Manifest;
    if (
      m.version !== 1 ||
      m.symbol !== symbol ||
      !Array.isArray(m.files) ||
      !Number.isSafeInteger(m.bars) ||
      m.bars < 0 ||
      (m.bars === 0 &&
        (m.firstEndMs !== null ||
          m.lastEndMs !== null ||
          m.files.length !== 0)) ||
      (m.bars > 0 &&
        (!Number.isSafeInteger(m.firstEndMs) ||
          !Number.isSafeInteger(m.lastEndMs) ||
          m.firstEndMs! > m.lastEndMs! ||
          m.files.length === 0)) ||
      !Number.isSafeInteger(m.updatedAtMs) ||
      m.files.some(
        (f, index) =>
          !/^\d{4}-\d{2}$/.test(f.month) ||
          (index > 0 && m.files[index - 1]!.month >= f.month) ||
          !/^[a-f0-9]{64}\.parquet$/.test(f.file) ||
          !/^[a-f0-9]{64}$/.test(f.sha256) ||
          f.file !== `${f.sha256}.parquet`,
      ) ||
      m.revision !== revision(m.files)
    )
      throw new Error(`분봉 manifest가 손상되었습니다: ${symbol}`);
    return m;
  }
  private async load(
    symbol: string,
    manifest: Manifest,
    range?: { fromMs: number; toMs: number },
  ): Promise<IntradayBar[]> {
    const bars: IntradayBar[] = [];
    const fromMonth = range && monthOf(range.fromMs);
    const toMonth = range && monthOf(range.toMs);
    const entries = range
      ? manifest.files.filter(
          (entry) => entry.month >= fromMonth! && entry.month <= toMonth!,
        )
      : manifest.files;
    for (const entry of entries) {
      const bytes = await fs.readFile(path.join(this.dir(symbol), entry.file));
      if (hash(bytes) !== entry.sha256)
        throw new Error(`분봉 파일 checksum이 일치하지 않습니다: ${symbol}`);
      // 매번 파일 해시를 확인하므로 캐시가 있어도 삭제·손상된 원본을 숨기지 않는다.
      const key = `${symbol}:${entry.month}:${entry.sha256}`;
      let decoded = this.decoded.get(key);
      if (!decoded) {
        const file = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const rows = await parquetReadObjects({ file });
        const validated: IntradayBar[] = [];
        const number = (value: unknown) => typeof value === "bigint" ? Number(value) : value;
        for (const row of rows) {
          const bar = intradayBarSchema.parse({
            endMs: number(row.endMs), open: number(row.open), high: number(row.high),
            low: number(row.low), close: number(row.close), volume: number(row.volume),
          });
          if (monthOf(bar.endMs) !== entry.month ||
            (validated.length && validated[validated.length - 1]!.endMs >= bar.endMs))
            throw new Error("분봉 파일 순서가 올바르지 않습니다");
          validated.push(bar);
        }
        decoded = validated;
        this.decoded.set(key, decoded, decoded.length);
      }
      if (bars.length && decoded.length && bars[bars.length - 1]!.endMs >= decoded[0]!.endMs)
        throw new Error("분봉 파일 순서가 올바르지 않습니다");
      for (const bar of decoded) bars.push(bar);
    }
    if (
      entries.length === manifest.files.length &&
      (bars.length !== manifest.bars ||
        (bars[0]?.endMs ?? null) !== manifest.firstEndMs ||
        (bars.at(-1)?.endMs ?? null) !== manifest.lastEndMs)
    )
      throw new Error("분봉 manifest와 데이터가 일치하지 않습니다");
    return bars;
  }
  private async writeMonth(symbol: string, month: string, rows: IntradayBar[]): Promise<Entry> {
    const dir = this.dir(symbol);
    const buffer = parquetWriteBuffer({
      columnData: fields.map((name) => ({
        name,
        type: "INT64" as const,
        data: rows.map((row) => BigInt(row[name])),
      })),
    });
    const bytes = new Uint8Array(buffer);
    const sha256 = hash(bytes);
    const file = `${sha256}.parquet`;
    const target = path.join(dir, file);
    let exists = false;
    try {
      const old = await fs.readFile(target);
      if (hash(old) !== sha256)
        throw new Error(`분봉 파일 checksum이 일치하지 않습니다: ${symbol}`);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!exists) await this.atomicWrite(target, bytes);
    return { month, file, sha256 };
  }
  private async publish(
    symbol: string,
    bars: IntradayBar[],
    nowMs: number,
  ): Promise<Manifest> {
    const dir = this.dir(symbol);
    await fs.mkdir(dir, { recursive: true });
    const months = new Map<string, IntradayBar[]>();
    for (const bar of bars) {
      const month = monthOf(bar.endMs);
      const rows = months.get(month) ?? [];
      rows.push(bar);
      months.set(month, rows);
    }
    const files: Entry[] = [];
    for (const [month, rows] of months) {
      files.push(await this.writeMonth(symbol, month, rows));
    }
    const m: Manifest = {
      version: 1,
      symbol,
      files,
      revision: revision(files),
      bars: bars.length,
      firstEndMs: bars[0]?.endMs ?? null,
      lastEndMs: bars.at(-1)?.endMs ?? null,
      updatedAtMs: nowMs,
    };
    await this.atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(m));
    return m;
  }
  private async atomicWrite(
    target: string,
    data: Uint8Array | string,
  ): Promise<void> {
    const tmp = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, data, { flag: "wx" });
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  async list(): Promise<IntradaySymbolData[]> {
    return this.gate(async () => {
      let entries: string[];
      try {
        entries = await fs.readdir(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const result: IntradaySymbolData[] = [];
      for (const symbol of entries
        .filter((entry) => /^\d{6}$/.test(entry))
        .sort()) {
        const m = await this.manifest(symbol);
        if (m) result.push(this.summary(m));
      }
      return result;
    });
  }
  private summary(m: Manifest): IntradaySymbolData {
    return {
      symbol: m.symbol,
      bars: m.bars,
      firstEndMs: m.firstEndMs,
      lastEndMs: m.lastEndMs,
      revision: m.revision,
      updatedAtMs: m.updatedAtMs,
    };
  }
  async read(
    symbol: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ bars: IntradayBar[]; revision: string }> {
    return this.gate(async () => {
      if (
        !Number.isSafeInteger(fromMs) ||
        !Number.isSafeInteger(toMs) ||
        fromMs > toMs
      )
        throw new Error("분봉 조회 범위가 올바르지 않습니다");
      const m = await this.manifest(symbol);
      if (!m) return { bars: [], revision: revision([]) };
      const bars = await this.load(symbol, m, { fromMs, toMs });
      return {
        // 호출자가 반환된 봉을 바꾸어도 검증된 내부 캐시는 오염되지 않는다.
        bars: bars.filter((bar) => bar.endMs >= fromMs && bar.endMs <= toMs).map((bar) => ({ ...bar })),
        revision: m.revision,
      };
    });
  }
  private async checkSymbolCapacity(symbol: string): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return; }
    if (names.filter(name => /^\d{6}$/.test(name)).length >= 100)
      throw new Error(`초기 분봉 보관은 최대 100종목입니다: ${symbol}`);
  }
  async merge(
    symbol: string,
    incoming: IntradayBar[],
    nowMs: number,
  ): Promise<IntradaySymbolData> {
    return this.gate(async () => {
      intradaySymbolSchema.parse(symbol);
      if (!Number.isSafeInteger(nowMs))
        throw new Error("보관 기준 시각이 올바르지 않습니다");
      const cutoff = nowMs - INTRADAY_RETENTION_DAYS * 86_400_000;
      const m = await this.manifest(symbol);
      if (!m) await this.checkSymbolCapacity(symbol);
      const existing = m ? await this.load(symbol, m) : [];
      const bars = new Map(
        existing
          .filter((bar) => bar.endMs >= cutoff)
          .map((bar) => [bar.endMs, bar]),
      );
      for (const raw of incoming) {
        const bar = intradayBarSchema.parse(raw);
        if (bar.endMs >= cutoff && bar.endMs <= nowMs) bars.set(bar.endMs, bar);
      }
      return this.summary(
        await this.publish(
          symbol,
          [...bars.values()].sort((a, b) => a.endMs - b.endMs),
          nowMs,
        ),
      );
    });
  }
  /** 기존 확정 봉을 우선하며 변경된 월 파일과 manifest만 교체한다. */
  async mergeMissing(symbol: string, incoming: IntradayBar[], nowMs: number): Promise<IntradaySymbolData> {
    return this.gate(async () => {
      intradaySymbolSchema.parse(symbol);
      if (!Number.isSafeInteger(nowMs)) throw new Error("보관 기준 시각이 올바르지 않습니다");
      const cutoff = nowMs - INTRADAY_RETENTION_DAYS * 86_400_000;
      const candidates = incoming.map(bar => intradayBarSchema.parse(bar))
        .filter(bar => bar.endMs >= cutoff && bar.endMs <= nowMs - 60_000);
      const old = await this.manifest(symbol);
      if (!old && candidates.length) await this.checkSymbolCapacity(symbol);
      const files = new Map((old?.files ?? []).map(entry => [entry.month, entry]));
      const monthRows = new Map<string, IntradayBar[]>();
      const loadMonth = async (month: string): Promise<IntradayBar[]> => {
        const cached = monthRows.get(month);
        if (cached) return cached;
        const entry = files.get(month);
        const [year, number] = month.split("-").map(Number);
        const rows = entry && old ? await this.load(symbol, old, { fromMs: Date.UTC(year!, number! - 1, 1) - 9 * 3_600_000, toMs: Date.UTC(year!, number!, 1) - 9 * 3_600_000 - 1 }) : [];
        const monthOnly = rows.filter(bar => monthOf(bar.endMs) === month);
        monthRows.set(month, monthOnly);
        return monthOnly;
      };
      let count = old?.bars ?? 0;
      const changed = new Set<string>();
      if (old?.firstEndMs !== null && old?.firstEndMs !== undefined && old.firstEndMs < cutoff) {
        for (const entry of old.files) {
          if (entry.month > monthOf(cutoff)) break;
          const rows = await loadMonth(entry.month);
          const kept = rows.filter(bar => bar.endMs >= cutoff);
          if (kept.length !== rows.length) { count -= rows.length - kept.length; monthRows.set(entry.month, kept); changed.add(entry.month); }
        }
      }
      for (const bar of candidates) {
        const month = monthOf(bar.endMs);
        const rows = await loadMonth(month);
        if (!rows.some(row => row.endMs === bar.endMs)) { rows.push(bar); count++; changed.add(month); }
      }
      if (!changed.size && old) return this.summary(old);
      if (!changed.size) return { symbol, bars: 0, firstEndMs: null, lastEndMs: null, revision: revision([]), updatedAtMs: nowMs };
      await fs.mkdir(this.dir(symbol), { recursive: true });
      for (const month of changed) {
        const rows = monthRows.get(month)!;
        rows.sort((a, b) => a.endMs - b.endMs);
        if (rows.length) files.set(month, await this.writeMonth(symbol, month, rows));
        else files.delete(month);
      }
      const entries = [...files.values()].sort((a, b) => a.month.localeCompare(b.month));
      const firstRows = entries.length ? await loadMonth(entries[0]!.month) : [];
      const lastRows = entries.length ? await loadMonth(entries.at(-1)!.month) : [];
      const m: Manifest = { version: 1, symbol, files: entries, revision: revision(entries), bars: count,
        firstEndMs: firstRows[0]?.endMs ?? null, lastEndMs: lastRows.at(-1)?.endMs ?? null, updatedAtMs: nowMs };
      await this.atomicWrite(path.join(this.dir(symbol), "manifest.json"), JSON.stringify(m));
      const keep = new Set(entries.map(entry => entry.file));
      for (const file of await fs.readdir(this.dir(symbol)))
        if (/^[a-f0-9]{64}\.parquet$/.test(file) && !keep.has(file)) await fs.rm(path.join(this.dir(symbol), file), { force: true });
      return this.summary(m);
    });
  }
  async prune(nowMs: number): Promise<void> {
    await this.gate(async () => {
      if (!Number.isSafeInteger(nowMs))
        throw new Error("보관 기준 시각이 올바르지 않습니다");
      let entries: string[];
      try {
        entries = await fs.readdir(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const cutoff = nowMs - INTRADAY_RETENTION_DAYS * 86_400_000;
      for (const symbol of entries.filter((entry) => /^\d{6}$/.test(entry))) {
        const old = await this.manifest(symbol);
        if (!old) continue;
        let current = old;
        if (old.firstEndMs !== null && old.firstEndMs < cutoff) {
          const bars = await this.load(symbol, old);
          current = await this.publish(
            symbol,
            bars.filter((bar) => bar.endMs >= cutoff),
            nowMs,
          );
        }
        const keep = new Set(current.files.map((entry) => entry.file));
        for (const file of await fs.readdir(this.dir(symbol)))
          if (
            (/^[a-f0-9]{64}\.parquet$/.test(file) && !keep.has(file)) ||
            /^\.[0-9a-f-]{36}\.tmp$/.test(file)
          )
            await fs.unlink(path.join(this.dir(symbol), file));
      }
    });
  }
}
