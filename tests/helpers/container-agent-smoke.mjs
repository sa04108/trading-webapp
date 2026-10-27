import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';

// 최종 이미지 안에서 실제 CLI·환경변수·네이티브 모듈·WSS 프로토콜을 확인한다.
const require = createRequire('/opt/quant-agent/package.json');
const { WebSocketServer } = require('ws');
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const token = 'container-smoke-token-'.padEnd(48, 't');
const child = spawn('/opt/quant-agent/quant-agent', ['run'], {
  env: { ...process.env, QUANT_AGENT_SERVER_URL: `http://127.0.0.1:${server.address().port}`, QUANT_AGENT_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const timeout = setTimeout(() => { child.kill('SIGKILL'); console.error('Container agent connection timed out'); process.exit(1); }, 20_000);
try {
  await new Promise((resolve, reject) => {
    child.once('exit', code => { if (code !== 0) reject(new Error(`Agent exited ${code}: ${logs}`)); });
    server.on('connection', (socket, request) => {
      try { assert.equal(request.headers.authorization, `Bearer ${token}`); } catch (error) { reject(error); return; }
      socket.on('message', raw => {
        try {
          const message = JSON.parse(raw);
          if (message.type === 'HELLO') {
            const versions = JSON.parse(fs.readFileSync('/opt/quant-agent/dist/runtime-versions.json', 'utf8'));
            assert.equal(message.runnerVersion, versions.agentVersion);
            assert.equal(message.protocolVersion, 3);
            socket.send(JSON.stringify({ type: 'WELCOME', runnerVersion: versions.agentVersion }));
          }
          if (message.type === 'CAPACITY') resolve();
        } catch (error) { reject(error); }
      });
    });
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync('/var/lib/quant-agent/settings.json'), false);
  assert.equal(fs.existsSync('/var/lib/quant-agent/agent.pid'), false);
  assert.equal(logs.includes(token), false);
  console.log('Container agent: authenticated, advertised capacity, stopped cleanly; credentials were not persisted.');
} finally {
  clearTimeout(timeout);
  child.kill('SIGKILL');
  for (const client of server.clients) client.terminate();
  await new Promise(resolve => server.close(resolve));
}
