#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { builtinModules } from "node:module";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 배포 산출물의 실행 코드를 단일 독립 파일로 고정한다. */
export async function buildTradingArtifacts({ outputRoot = path.join(root, "dist", "trading-artifacts"), runtimeVersionsPath = path.join(root, "dist", "runtime-versions.json") } = {}) {
  const versions = JSON.parse(await readFile(runtimeVersionsPath, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(versions.executionVersion)) throw new Error("백테스트 실행 버전이 올바르지 않습니다");
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const built = await build({
    configFile: false,
    logLevel: "error",
    define: { __TRADING_EXECUTION_VERSION__: JSON.stringify(versions.executionVersion) },
    build: {
      target: "node24", ssr: path.join(root, "src/server/modules/trading/infrastructure/strategy-bundle-entry.ts"), write: false, minify: false,
      rollupOptions: { external: (id) => builtins.has(id), output: { format: "es", inlineDynamicImports: true } },
    },
    ssr: { noExternal: true },
  });
  if (Array.isArray(built) || built.output.length !== 1 || built.output[0].type !== "chunk") throw new Error("전략 번들이 단일 파일이 아닙니다");
  const chunk = built.output[0];
  if (chunk.imports.some((id) => !builtins.has(id)) || chunk.dynamicImports.length) throw new Error("전략 번들에 외부 의존성이 있습니다");
  const code = Buffer.from(chunk.code);
  const temporary = await mkdtemp(path.join(tmpdir(), "trading-build-"));
  try {
    const modulePath = path.join(temporary, "bundle.mjs");
    await writeFile(modulePath, code);
    const module = await import(pathToFileURL(modulePath).href);
    const metadata = { formatVersion: module.formatVersion, nodeMajor: module.nodeMajor, executionVersion: module.executionVersion, strategies: module.strategies };
    const footer = Buffer.from(`\n//# trading-metadata=${Buffer.from(JSON.stringify(metadata)).toString("base64")}\n`);
    const bytes = Buffer.concat([code, footer]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const manifest = { ...metadata, artifactHash: hash };
    if (module.lifecycleAbi !== 1 || typeof module.reconcileState !== "function" || manifest.formatVersion !== 1 || manifest.nodeMajor !== 24 || manifest.executionVersion !== versions.executionVersion || !Array.isArray(manifest.strategies) || manifest.strategies.length === 0) throw new Error("전략 번들 메타데이터가 올바르지 않습니다");
    await mkdir(outputRoot, { recursive: true });
    const file = path.join(outputRoot, `${hash}.mjs`);
    const tempBundle = path.join(outputRoot, `.${hash}.${process.pid}.tmp`);
    const tempManifest = path.join(outputRoot, `.manifest.${process.pid}.tmp`);
    await writeFile(tempBundle, bytes); await rename(tempBundle, file);
    await writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`); await rename(tempManifest, path.join(outputRoot, "manifest.json"));
    return manifest;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildTradingArtifacts();
