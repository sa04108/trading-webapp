#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import yaml from 'js-yaml';
import { runtimeGraph, AGENT_ENTRYPOINTS } from './lib/runtime-graph.mjs';
import { lockedDependencies } from './build-runtime-versions.mjs';

// 서버에서 검증한 정확한 전이 의존성을 agent에도 사용하되 서버 전용 패키지는 제외한다.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const lock = yaml.load(read('pnpm-lock.yaml'));
const rootManifest = JSON.parse(read('package.json'));
const names = runtimeGraph(root, AGENT_ENTRYPOINTS).packages;
const selected = lockedDependencies(lock, names);
const dependencies = Object.fromEntries(names.map((name) => [name, selected.roots[name].split('(')[0]]));
const manifest = { name: 'quant-agent-runtime', version: '0.0.0', private: true, type: 'module', packageManager: rootManifest.packageManager, engines: rootManifest.engines, dependencies };
fs.writeFileSync(new URL('../packages/agent/package.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(new URL('../packages/agent/pnpm-lock.yaml', import.meta.url), yaml.dump({
  lockfileVersion: lock.lockfileVersion, settings: lock.settings,
  importers: { '.': { dependencies: Object.fromEntries(names.map((name) => [name, { specifier: dependencies[name], version: selected.roots[name] }])) } },
  packages: selected.packages, snapshots: selected.snapshots,
}, { sortKeys: false, lineWidth: -1, quotingType: "'" }));
