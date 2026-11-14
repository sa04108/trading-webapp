import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ParquetIntradayStore } from "../../src/server/modules/intraday/infrastructure/parquet-intraday-store.js";

const minute = 60_000;
const now = Date.UTC(2026, 10, 1);
const cutoff = now - 365 * 86_400_000;
const bar = (endMs: number, close = 100) => ({
  endMs,
  open: 100,
  high: 110,
  low: 90,
  close,
  volume: 12,
});

describe("분봉 Parquet 저장", () => {
  it("조회 월 이외의 파일을 읽지 않고 만료가 없으면 정리 시 본문을 읽지 않는다", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "intraday-range-"));
    try {
      const store = new ParquetIntradayStore(root);
      const first = Date.UTC(2026, 7, 1);
      const second = Date.UTC(2026, 8, 1);
      await store.merge("005930", [bar(first), bar(second)], now);
      const directory = path.join(root, "005930");
      const manifest = JSON.parse(
        await readFile(path.join(directory, "manifest.json"), "utf8"),
      );
      await writeFile(path.join(directory, manifest.files[0].file), "broken");
      expect((await store.read("005930", second, second)).bars).toEqual([
        bar(second),
      ]);
      await expect(store.prune(now)).resolves.toBeUndefined();
      await expect(store.read("005930", first, first)).rejects.toThrow(
        /checksum/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("분봉 정정과 보관 경계를 실제 Parquet로 보존하고 손상을 거부한다", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "intraday-store-"));
    try {
      const store = new ParquetIntradayStore(root);
      expect(await store.list()).toEqual([]);
      await store.merge(
        "005930",
        [bar(cutoff - minute), bar(cutoff), bar(now - minute)],
        now,
      );
      const before = await store.read("005930", cutoff, now);
      expect(before.bars.map((b) => b.endMs)).toEqual([cutoff, now - minute]);
      await store.merge("005930", [bar(now - minute, 105)], now);
      const after = await store.read("005930", cutoff, now);
      expect(after.bars[1]!.close).toBe(105);
      expect(after.revision).not.toBe(before.revision);
      await store.prune(now + minute);
      expect(
        (await store.read("005930", cutoff, now)).bars.map((b) => b.endMs),
      ).toEqual([now - minute]);
      const files = await readdir(path.join(root, "005930"));
      const manifest = JSON.parse(
        await readFile(path.join(root, "005930", "manifest.json"), "utf8"),
      );
      expect(files.filter((f) => f.endsWith(".parquet"))).toEqual([
        manifest.files[0].file,
      ]);
      await writeFile(
        path.join(root, "005930", manifest.files[0].file),
        "broken",
      );
      await expect(store.read("005930", cutoff, now)).rejects.toThrow(
        /checksum/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
