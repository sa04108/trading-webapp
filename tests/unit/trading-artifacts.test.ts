import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StrategyArtifacts } from "../../src/server/modules/trading/infrastructure/strategy-artifacts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function build(root: string, executionVersion: string): string {
  const buildRoot = path.join(root, "build");
  mkdirSync(buildRoot, { recursive: true });
  const versions = path.join(root, "versions.json");
  writeFileSync(versions, JSON.stringify({ executionVersion }));
  execFileSync(process.execPath, ["--input-type=module", "-e", 'import {buildTradingArtifacts} from "./scripts/build-trading-artifacts.mjs"; await buildTradingArtifacts({outputRoot:process.argv[1],runtimeVersionsPath:process.argv[2]})', buildRoot, versions], { cwd: process.cwd(), stdio: "pipe" });
  return buildRoot;
}

describe("strategy artifacts", () => {
  it("archives immutable bundles across builds and rejects tampering", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "strategy-artifacts-test-")); roots.push(root);
    const buildRoot = build(root, "a".repeat(64));
    const options = { dataRoot: path.join(root, "data"), buildRoot };
    const first = new StrategyArtifacts(options);
    const initial = first.list();
    expect(initial.length).toBeGreaterThan(0);
    const original = initial[0]!;
    expect(original.latest).toBe(true);
    const strategy = await first.load(original.strategyId, original.artifactHash);
    expect(strategy.version).toBe(original.version);
    build(root, "b".repeat(64));
    const restarted = new StrategyArtifacts(options);
    const old = restarted.list().find((item) => item.strategyId === original.strategyId && item.artifactHash === original.artifactHash);
    const current = restarted.list().find((item) => item.strategyId === original.strategyId && item.latest);
    expect(old?.latest).toBe(false);
    expect(current?.artifactHash).not.toBe(original.artifactHash);
    expect((await restarted.load(original.strategyId, original.artifactHash)).version).toBe(original.version);
    writeFileSync(restarted.bundlePath(original.artifactHash), "tampered");
    await expect(restarted.load(original.strategyId, original.artifactHash)).rejects.toThrow();
  }, 30_000);
  it("rejects modified archived manifests and does not invent a current version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "strategy-artifacts-test-")); roots.push(root);
    const buildRoot = build(root, "c".repeat(64));
    const options = { dataRoot: path.join(root, "data"), buildRoot };
    const catalog = new StrategyArtifacts(options);
    const artifact = catalog.list()[0]!;
    const manifest = path.join(root, "data", "trading-artifacts", artifact.artifactHash, "manifest.json");
    const content = JSON.parse(readFileSync(manifest, "utf8")) as { strategies: { version: string }[] };
    content.strategies[0]!.version = "altered";
    writeFileSync(manifest, JSON.stringify(content));
    expect(() => new StrategyArtifacts(options)).toThrow();
    const empty = new StrategyArtifacts({ dataRoot: path.join(root, "empty"), buildRoot: path.join(root, "missing") });
    expect(empty.list()).toEqual([]);
  }, 30_000);
});
