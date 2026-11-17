import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as parquet from "hyparquet";
import { ParquetIntradayStore } from "../../src/server/modules/intraday/infrastructure/parquet-intraday-store.js";

vi.mock("hyparquet", { spy: true });

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
  // 기존 왕복 검사는 반복 해독 비용과 반환값 변경·다른 인스턴스 정정에 의한 캐시 오염을 잡지 못한다.
  it("검증된 월을 재사용하되 반환값 변경, 외부 정정과 원본 손상을 분리한다", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "intraday-cache-"));
    const decode = vi.mocked(parquet.parquetReadObjects);
    try {
      const store = new ParquetIntradayStore(root);
      const first = Date.UTC(2026, 8, 1);
      const second = Date.UTC(2026, 9, 1);
      await store.merge("005930", [bar(first), bar(second)], now);
      const initial = await store.read("005930", first, second);
      initial.bars[0]!.close = 109;
      decode.mockClear();
      expect((await store.read("005930", first, first)).bars).toEqual([bar(first)]);
      expect(decode).not.toHaveBeenCalled();
      await new ParquetIntradayStore(root).merge("005930", [bar(second, 105)], now);
      decode.mockClear();
      const corrected = await store.read("005930", first, second);
      expect(corrected.bars).toEqual([bar(first), bar(second, 105)]);
      expect(corrected.revision).not.toBe(initial.revision);
      expect(decode).toHaveBeenCalledTimes(1);
      const directory = path.join(root, "005930");
      const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, bars: manifest.bars + 1 }));
      await expect(store.read("005930", first, second)).rejects.toThrow(/manifest와 데이터/);
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
      const file = path.join(directory, manifest.files[1].file);
      const bytes = await readFile(file);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(file, bytes);
      await expect(store.read("005930", second, second)).rejects.toThrow(/checksum/);
      await unlink(file);
      await expect(store.read("005930", second, second)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      decode.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
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
