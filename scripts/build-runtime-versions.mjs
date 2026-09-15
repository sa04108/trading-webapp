#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import process from 'node:process';
import yaml from 'js-yaml';
import ts from 'typescript';
import { runtimeGraph, AGENT_ENTRYPOINTS, readEmitOptions } from './lib/runtime-graph.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function filesIn(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesIn(root, `${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
}
/** 잠금 파일에서 해당 도메인의 직접·전이 의존성만 선택한다. */
export function lockedDependencies(lock, names) {
  const snapshots = {};
  const packages = {};
  const roots = {};
  const visit = (name, version) => {
    const key = `${name}@${version}`;
    if (snapshots[key]) return;
    const snapshot = lock.snapshots[key];
    const packageKey = `${name}@${version.split('(')[0]}`;
    if (!snapshot || !lock.packages[packageKey]) throw new Error(`잠금 의존성을 찾을 수 없습니다: ${key}`);
    snapshots[key] = snapshot;
    packages[packageKey] = lock.packages[packageKey];
    for (const [child, ref] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visit(child, ref);
  };
  for (const name of names) {
    const dependency = lock.importers['.'].dependencies[name];
    if (!dependency) throw new Error(`운영 의존성 목록에 없습니다: ${name}`);
    roots[name] = dependency.version;
    visit(name, dependency.version);
  }
  return { roots, snapshots, packages };
}

export function generateRuntimeVersions(root = repository, overrides = {}) {
  const read = (file) => overrides[file] ?? fs.readFileSync(path.join(root, file), 'utf8');
  const lock = yaml.load(read('pnpm-lock.yaml'));
  const agentLock = yaml.load(read('packages/agent/pnpm-lock.yaml'));
  const manifest = JSON.parse(read('packages/agent/package.json'));
  const emitOptions = readEmitOptions(root, 'tsconfig.build.json', overrides);
  if (digest(emitOptions) !== digest(readEmitOptions(root, 'tsconfig.agent.json', overrides))) throw new Error('서버와 agent의 코드 생성 설정은 같아야 합니다');
  const common = { emitOptions, scheme: 'content-v1', node: process.versions.node, compiler: ts.version, compilerPackage: lock.packages[`typescript@${ts.version}`], generator: read('scripts/build-runtime-versions.mjs'), graph: read('scripts/lib/runtime-graph.mjs') };
  const graph = (entries) => runtimeGraph(root, entries, { overrides, emitOptions });
  const inputs = (entries, extra = [], agent = false) => {
    const closure = graph(entries);
    return { ...common, files: Object.fromEntries(closure.files), dependencies: lockedDependencies(agent ? agentLock : lock, closure.packages), extra: Object.fromEntries(extra.map((file) => [file, read(file)])) };
  };
  const migrations = (kind) => filesIn(root, `migrations/${kind}`).filter((file) => file.endsWith('.sql') || file.endsWith('_journal.json'));
  const collectionEntries = ['src/server/modules/agents/application/agent-collection-runtime.ts'];
  const collectionVersion = digest(inputs(collectionEntries, migrations('data')));
  const executionVersion = digest(inputs(['src/runtime/workers/backtest-child.ts']));
  const previewVersion = digest({ ...inputs(['src/runtime/workers/preparation-child.ts']), collectionVersion });
  const validationVersion = digest({ ...inputs(['src/server/modules/backtest/application/period-validation-service.ts']), previewVersion, executionVersion });
  const agentGraph = graph(AGENT_ENTRYPOINTS);
  if (agentGraph.packages.join() !== Object.keys(manifest.dependencies).sort().join()) throw new Error('agent 운영 의존성 목록과 실행 그래프가 다릅니다');
  for (const name of agentGraph.packages) {
    if (lock.importers['.'].dependencies[name].version.split('(')[0] !== agentLock.importers['.'].dependencies[name].version.split('(')[0]) throw new Error(`서버와 agent 의존성 버전이 다릅니다: ${name}`);
  }
  if (digest(lockedDependencies(lock, agentGraph.packages)) !== digest(lockedDependencies(agentLock, agentGraph.packages))) throw new Error('서버와 agent의 전이 의존성이 다릅니다. node scripts/sync-agent-dependencies.mjs를 실행하세요');
  const agentVersion = digest(inputs(AGENT_ENTRYPOINTS, [...migrations('agent'), 'packages/agent/package.json', 'packages/agent/pnpm-workspace.yaml', 'scripts/build-agent-client.mjs'], true));
  return { schemaVersion: 1, agentVersion, collectionVersion, previewVersion, executionVersion, validationVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const versions = JSON.stringify(generateRuntimeVersions(), null, 2) + '\n';
  if (process.argv.includes('--print')) process.stdout.write(versions);
  else {
    fs.mkdirSync(path.join(repository, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'dist/runtime-versions.json'), versions);
  }
}
