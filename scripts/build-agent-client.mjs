#!/usr/bin/env node
// Linux 호스트의 Node와 네이티브 의존성으로 다운로드 가능한 클라이언트를 만든다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runtimeGraph, AGENT_ENTRYPOINTS } from './lib/runtime-graph.mjs';
import { generateRuntimeVersions } from './build-runtime-versions.mjs';

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`클라이언트 빌드 실패: ${command}`);
}
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('Linux x64/arm64의 Node 24 환경에서 클라이언트를 빌드하세요');
}
if (!process.argv.includes('--prepared')) {
  fs.mkdirSync('dist', { recursive: true });
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) throw new Error('빌드의 Git 버전을 확인할 수 없습니다');
  fs.writeFileSync('dist/build-info.json', JSON.stringify({ gitSha: git.stdout.trim(), builtAt: new Date().toISOString() }));
}
const root = process.cwd();
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'));
const versions = generateRuntimeVersions(root);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-agent-build-'));
const output = path.join(root, 'dist/clients');
fs.mkdirSync(output, { recursive: true });
try {
  const compiled = path.join(temporary, 'compiled');
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.agent.json', '--outDir', compiled]);
  const entries = AGENT_ENTRYPOINTS.map((file) => file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
  fs.renameSync(compiled, path.join(temporary, 'dist'));
  const graph = runtimeGraph(temporary, entries, { compiled: true });
  for (const file of graph.files.keys()) {
    if (!/^dist\/(agent|runtime|shared)\//.test(file)) throw new Error(`서버 전용 코드가 agent 패키지에 들어왔습니다: ${file}`);
  }
  // 타입 검사 때문에 생성된 파일 중 실행 그래프에 없는 파일은 게시하지 않는다.
  function prune(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) prune(file);
      else if (!graph.files.has(path.relative(temporary, file).replaceAll(path.sep, '/'))) fs.unlinkSync(file);
    }
  }
  prune(path.join(temporary, 'dist'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) fs.copyFileSync(path.join(root, 'packages/agent', file), path.join(temporary, file));
  run('pnpm', ['install', '--prod', '--offline', '--frozen-lockfile'], temporary);
  fs.copyFileSync(path.join(root, 'dist/build-info.json'), path.join(temporary, 'dist/build-info.json'));
  fs.writeFileSync(path.join(temporary, 'dist/runtime-versions.json'), JSON.stringify(versions, null, 2));
  fs.cpSync(path.join(root, 'migrations/agent'), path.join(temporary, 'migrations/agent'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'bin'));
  fs.copyFileSync(process.execPath, path.join(temporary, 'bin/node'));
  fs.chmodSync(path.join(temporary, 'bin/node'), 0o755);
  fs.writeFileSync(path.join(temporary, 'quant-agent'), '#!/bin/sh\nset -eu\nagent_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$agent_root/bin/node" "$agent_root/dist/agent/main.js" "$@"\n', { mode: 0o755 });
  run(path.join(temporary, 'bin/node'), ['dist/agent/main.js', '--check'], temporary);
  const file = `quant-agent-linux-${process.arch}.tar.gz`;
  const destination = path.join(output, file);
  const stagedArchive = `${destination}.tmp`;
  run('tar', ['-czf', stagedArchive, '-C', temporary, '.']);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(stagedArchive)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  fs.renameSync(stagedArchive, destination);
  const manifestPath = path.join(output, 'manifest.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { clients: [] };
  const clients = previous.runnerVersion === versions.agentVersion ? previous.clients.filter((client) => client.arch !== process.arch) : [];
  clients.push({ buildGitSha: metadata.gitSha, arch: process.arch, file, sha256, bytes: fs.statSync(destination).size,
    minimumGlibc: process.report.getReport().header.glibcVersionRuntime });
  fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify({ runnerVersion: versions.agentVersion, buildGitSha: metadata.gitSha, clients }, null, 2));
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  process.stdout.write(`Linux 클라이언트 생성: ${destination}\n`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
