import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { AgentSettings } from './config.js';

export function installRoot(): string { return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'), 'quant-agent'); }
function command(program: string, args: string[]): void {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${program} 실행 실패`);
}
function systemdQuote(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`; }

export function activate(source: string, version: string, destination = installRoot()): void {
  if (!/^[a-f0-9]{40,64}$/.test(version)) throw new Error('클라이언트 버전 형식이 올바르지 않습니다');
  if (!fs.existsSync(path.join(source, 'bin/node')) || !fs.existsSync(path.join(source, 'quant-agent'))) throw new Error('빌드된 Linux 클라이언트 패키지에서 설치하세요');
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'dist/build-info.json'), 'utf8')) as { gitSha: string };
  if (metadata.gitSha !== version) throw new Error('클라이언트 패키지의 버전이 다릅니다');
  fs.mkdirSync(path.join(destination, 'releases'), { recursive: true, mode: 0o700 });
  const release = path.join(destination, 'releases', version);
  if (path.resolve(source) !== release && !fs.existsSync(release)) {
    const staging = `${release}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
    command(path.join(staging, 'bin/node'), [path.join(staging, 'dist/agent/main.js'), '--check']);
    fs.renameSync(staging, release);
  }
  command(path.join(release, 'bin/node'), [path.join(release, 'dist/agent/main.js'), '--check']);
  const current = path.join(destination, 'current');
  const previous = fs.existsSync(current) ? fs.realpathSync(current) : null;
  fs.rmSync(`${current}.tmp`, { force: true });
  fs.symlinkSync(release, `${current}.tmp`);
  fs.renameSync(`${current}.tmp`, current);
  for (const name of fs.readdirSync(path.join(destination, 'releases'))) {
    const candidate = path.join(destination, 'releases', name);
    if (/^[a-f0-9]{40,64}$/.test(name) && candidate !== release && candidate !== previous) fs.rmSync(candidate, { recursive: true, force: true });
  }
}

export function installService(source: string, version: string, state: string): void {
  const destination = installRoot();
  activate(source, version, destination);
  const unitDirectory = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd/user');
  fs.mkdirSync(unitDirectory, { recursive: true });
  const executable = path.join(destination, 'current/quant-agent');
  const unit = `[Unit]\nDescription=Quant calculation agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(executable)} run --state ${systemdQuote(state)}\nRestart=always\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nNice=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  fs.writeFileSync(path.join(unitDirectory, 'quant-agent.service'), unit, { mode: 0o600 });
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', '--now', 'quant-agent.service']);
  const linger = spawnSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' });
  if (linger.status !== 0) console.log('로그아웃 후 상시 실행 설정을 완료하지 못했습니다. 관리자가 loginctl enable-linger 사용자명으로 활성화하세요.');
}

const packageManifestSchema = z.object({ runnerVersion: z.string(), clients: z.array(z.object({ arch: z.string(), file: z.string().regex(/^quant-agent-linux-(x64|arm64)\.tar\.gz$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() })) });

export async function downloadUpdate(settings: AgentSettings, version: string, directory: string): Promise<string> {
  const headers = { authorization: `Bearer ${settings.token}` };
  const response = await fetch(`${settings.serverUrl}/api/agents/client/latest`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`클라이언트 명세 조회 실패: HTTP ${response.status}`);
  const manifest = packageManifestSchema.parse(await response.json());
  if (manifest.runnerVersion !== version) throw new Error('운영 서버와 게시된 클라이언트 버전이 다릅니다');
  const client = manifest.clients.find((entry) => entry.arch === process.arch);
  if (!client) throw new Error('현재 CPU 아키텍처의 클라이언트가 게시되지 않았습니다');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = path.join(directory, 'client.tar.gz.part');
  const result = await fetch(`${settings.serverUrl}/api/agents/client/${client.file}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15 * 60_000) });
  if (!result.ok || !result.body) throw new Error(`클라이언트 다운로드 실패: HTTP ${result.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > client.bytes) { callback(new Error('클라이언트 파일 크기 초과')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(result.body), verify, fs.createWriteStream(archive, { mode: 0o600 }));
  if (bytes !== client.bytes || hash.digest('hex') !== client.sha256) throw new Error('클라이언트 다운로드 무결성 검사 실패');
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (listing.status !== 0 || listing.stdout.split('\n').some((name) => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('클라이언트 압축 파일 경로가 올바르지 않습니다');
  const unpacked = path.join(directory, 'unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked);
  command('tar', ['--no-same-owner', '-xzf', archive, '-C', unpacked]);
  command(path.join(unpacked, 'bin/node'), [path.join(unpacked, 'dist/agent/main.js'), '--check']);
  return unpacked;
}
