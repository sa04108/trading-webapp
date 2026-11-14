import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';

// 최종 서버 이미지에서 네이티브 의존성·마이그레이션·웹 파일·종료 처리를 함께 검사한다.
const root = '/opt/quant-platform';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-server-smoke-'));
const env = { ...process.env, NODE_ENV: 'production', APP_BIND_ADDRESS: '127.0.0.1', APP_PORT: '3199',
  SESSION_SECRET: 'container-smoke-session-'.padEnd(64, 's'), DATABASE_PATH: path.join(data, 'app.sqlite'),
  DATA_ROOT: path.join(data, 'market-data'), IMPORT_ROOT: path.join(data, 'imports'),
  EXPORT_ROOT: path.join(data, 'exports'), TEMP_ROOT: path.join(data, 'temp') };
execFileSync(process.execPath, ['dist/server/cli.js', 'db:prepare'], { cwd: root, env, stdio: 'pipe' });
const { buildWindowsAgentInstaller, agentContainerImage } = await import(`${root}/dist/server/modules/agents/infrastructure/agent-windows-installer.js`);
assert.match(buildWindowsAgentInstaller({ serverUrl: 'https://smoke.example.com', token: 't'.repeat(48), image: agentContainerImage() }), /powershell/i);
const versions = JSON.parse(fs.readFileSync(`${root}/dist/runtime-versions.json`, 'utf8'));
assert.match(versions.agentVersion, /^[a-f0-9]{64}$/);
assert.equal(versions.agentVersion, process.env.EXPECTED_AGENT_VERSION, '서버 이미지와 함께 게시한 Agent의 실행 버전이 같아야 한다');
assert.match(JSON.parse(fs.readFileSync(`${root}/dist/build-info.json`, 'utf8')).gitSha, /^[a-f0-9]{40,64}$/);
const child = spawn(process.execPath, ['dist/server/bootstrap/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    ready = await globalThis.fetch('http://127.0.0.1:3199/api/v1/health/ready').then(r => r.ok).catch(() => false);
    if (ready) break;
    await delay(100);
  }
  assert.equal(ready, true, logs);
  const web = await globalThis.fetch('http://127.0.0.1:3199/');
  assert.equal(web.status, 200);
  const html = await web.text();
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, '웹 번들이 있어야 한다');
  assert.equal((await globalThis.fetch(`http://127.0.0.1:3199${asset}`)).status, 200);
  child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(15_000, { timeout: true }, { ref: false })]);
  assert.deepEqual(result, { code: 0, signal: null }, logs);
  assert.ok(fs.existsSync(path.join(data, 'app.sqlite')));
  assert.ok(fs.existsSync(path.join(data, 'app.data.sqlite')));
  console.log('Server image: DB preparation, runtime versions, installer, web/readiness and SIGTERM passed.');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await exited;
  fs.rmSync(data, { recursive: true, force: true });
}
