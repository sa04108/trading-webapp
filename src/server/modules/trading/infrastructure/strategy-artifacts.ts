import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AnyTradingStrategy } from "../../../../runtime/modules/strategy/domain/strategy.js";
import type { TradingArtifact } from "../../../../shared/schemas/trading.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({ strategyId: z.string().min(1), name: z.string().min(1), description: z.string(), version: z.string().min(1), parameterSchema: z.record(z.string(), z.unknown()) }).strict();
const manifestSchema = z.object({ formatVersion: z.literal(1), nodeMajor: z.literal(24), executionVersion: hashSchema, artifactHash: hashSchema, strategies: z.array(entrySchema).min(1) }).strict().superRefine((value, ctx) => {
  if (new Set(value.strategies.map((item) => item.strategyId)).size !== value.strategies.length) ctx.addIssue({ code: "custom", message: "중복 전략 식별자" });
});
type Manifest = z.infer<typeof manifestSchema>;
function canonical(value: unknown): string {
  function sort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, sort(item)]));
    return v;
  }
  return JSON.stringify(sort(value));
}
function readRegular(file: string): Buffer {
  if (!lstatSync(file).isFile()) throw new Error("전략 산출물은 일반 파일이어야 합니다");
  return readFileSync(file);
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function parseManifest(bytes: Buffer): Manifest { return manifestSchema.parse(JSON.parse(bytes.toString("utf8"))); }
function verifyMetadata(bytes: Buffer, manifest: Manifest): void {
  const match = /\n\/\/# trading-metadata=([A-Za-z0-9+/=]+)\n$/.exec(bytes.toString("utf8"));
  if (!match?.[1]) throw new Error("전략 번들의 메타데이터가 없습니다");
  const metadata: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  const { artifactHash: _hash, ...expected } = manifest;
  if (canonical(metadata) !== canonical(expected)) throw new Error("전략 번들의 메타데이터가 일치하지 않습니다");
}

/** 승인된 빌드의 번들만 보관하며, 과거 번들은 덮어쓰지 않는다. */
export class StrategyArtifacts {
  private readonly archiveRoot: string;
  private readonly currentHash: string | null;
  constructor(options: { dataRoot: string; buildRoot?: string }) {
    this.archiveRoot = path.join(options.dataRoot, "trading-artifacts");
    mkdirSync(this.archiveRoot, { recursive: true });
    const buildRoot = options.buildRoot ?? path.join(process.cwd(), "dist", "trading-artifacts");
    const manifestPath = path.join(buildRoot, "manifest.json");
    if (!existsSync(manifestPath)) { this.currentHash = null; return; }
    const manifestBytes = readRegular(manifestPath);
    const manifest = parseManifest(manifestBytes);
    const bytes = readRegular(path.join(buildRoot, `${manifest.artifactHash}.mjs`));
    if (digest(bytes) !== manifest.artifactHash) throw new Error("현재 전략 번들의 해시가 일치하지 않습니다");
    verifyMetadata(bytes, manifest);
    const destination = path.join(this.archiveRoot, manifest.artifactHash);
    if (!existsSync(destination)) {
      const temporary = mkdtempSync(path.join(this.archiveRoot, ".archive-"));
      try {
        writeFileSync(path.join(temporary, "bundle.mjs"), bytes, { flag: "wx" });
        writeFileSync(path.join(temporary, "manifest.json"), manifestBytes, { flag: "wx" });
        try { renameSync(temporary, destination); } catch (error) { if (!existsSync(destination)) throw error; }
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    const archived = this.readArchive(manifest.artifactHash);
    if (canonical(archived) !== canonical(manifest)) throw new Error("보관된 전략 메타데이터가 현재 빌드와 다릅니다");
    this.currentHash = manifest.artifactHash;
  }
  private readArchive(hash: string): Manifest {
    hashSchema.parse(hash);
    const directory = path.join(this.archiveRoot, hash);
    if (!lstatSync(directory).isDirectory()) throw new Error("전략 보관 경로가 올바르지 않습니다");
    const manifest = parseManifest(readRegular(path.join(directory, "manifest.json")));
    const bytes = readRegular(path.join(directory, "bundle.mjs"));
    if (manifest.artifactHash !== hash || digest(bytes) !== hash) throw new Error("보관된 전략 번들의 해시가 일치하지 않습니다");
    verifyMetadata(bytes, manifest);
    return manifest;
  }
  list(): TradingArtifact[] {
    const entries: TradingArtifact[] = [];
    for (const dir of readdirSync(this.archiveRoot, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(dir.name)) continue;
      if (!dir.isDirectory()) throw new Error("전략 보관 경로가 올바르지 않습니다");
      const manifest = this.readArchive(dir.name);
      for (const strategy of manifest.strategies) entries.push({ ...strategy, artifactHash: manifest.artifactHash, executionVersion: manifest.executionVersion, latest: manifest.artifactHash === this.currentHash });
    }
    return entries;
  }
  bundlePath(hash: string): string {
    this.readArchive(hash);
    return path.join(this.archiveRoot, hash, "bundle.mjs");
  }
  async load(strategyId: string, artifactHash: string): Promise<AnyTradingStrategy> {
    const manifest = this.readArchive(artifactHash);
    if (Number(process.versions.node.split(".")[0]) !== manifest.nodeMajor) throw new Error("전략 번들의 Node 버전이 호환되지 않습니다");
    const metadata = manifest.strategies.find((entry) => entry.strategyId === strategyId);
    if (!metadata) throw new Error("해당 버전의 전략을 찾을 수 없습니다");
    const module = await import(pathToFileURL(this.bundlePath(artifactHash)).href) as { formatVersion?: unknown; nodeMajor?: unknown; executionVersion?: unknown; strategies?: unknown; getStrategy?: unknown; lifecycleAbi?: unknown; reconcileState?: unknown };
    if (module.lifecycleAbi !== 1 || typeof module.reconcileState !== "function" || module.formatVersion !== manifest.formatVersion || module.nodeMajor !== manifest.nodeMajor || module.executionVersion !== manifest.executionVersion || canonical(module.strategies) !== canonical(manifest.strategies) || typeof module.getStrategy !== "function") throw new Error("전략 번들 메타데이터가 일치하지 않습니다");
    const strategy = (module.getStrategy as (id: string) => AnyTradingStrategy | null)(strategyId);
    if (!strategy || strategy.id !== strategyId || strategy.version !== metadata.version || strategy.name !== metadata.name || strategy.description !== metadata.description || typeof strategy.initialize !== "function" || typeof strategy.onBars !== "function" || !strategy.parameterSchema || canonical(z.toJSONSchema(strategy.parameterSchema)) !== canonical(metadata.parameterSchema)) throw new Error("전략 번들의 구현이 메타데이터와 일치하지 않습니다");
    return strategy;
  }
}
