import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe('단일 서버 운영 진입점', () => {
  it('기존 접미사 파일이나 호환 래퍼 없이 일반 이름만 제공한다', () => {
    for (const file of ['scripts/deploy.sh', 'scripts/bootstrap.sh', 'infra/provision.sh']) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o111).not.toBe(0);
    }
    for (const file of ['scripts/deploy-app.sh', 'scripts/bootstrap-app.sh', 'infra/provision-app.sh', 'scripts/deploy.mjs']) {
      expect(existsSync(file)).toBe(false);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.deploy).toBe('bash scripts/deploy.sh');
  });

  it('배포 대상 이름과 다중 컴포넌트 분기가 남지 않는다', () => {
    const deploy = readFileSync('scripts/deploy.sh', 'utf8');
    expect(deploy).not.toMatch(/componentPrefix|connection\.component|stageAppDeployment|runAppPhase|APP_HOST|APP_SSH_/);
    expect(deploy).toContain('function readConnection(settings)');
    expect(deploy).toContain('HOST');
    expect(deploy).toContain('SSH_PORT');
    expect(deploy).toContain('/etc/quant-platform/app.env');
    expect(deploy).toContain('/var/lib/quant-platform/app.sqlite');
  });

  it('통합한 로컬 코드도 Node 문법 검사를 통과한다', () => {
    const script = readFileSync('scripts/deploy.sh', 'utf8');
    const local = script.split("<<'DEPLOY_LOCAL_NODE'\n")[1].split('\nDEPLOY_LOCAL_NODE')[0];
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: local, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('source는 함수만 정의하고 로컬 배포를 시작하지 않는다', () => {
    const result = spawnSync(bash, ['-c', 'source scripts/deploy.sh; declare -F rollback_transaction; declare -F verify_prepared_release'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rollback_transaction');
    expect(result.stdout).toContain('verify_prepared_release');
    expect(result.stderr).not.toContain('배포 환경 파일');
  });

  it('잘못된 내부 단계는 로컬 배포로 돌아가지 않고 거부한다', () => {
    const result = spawnSync(bash, ['scripts/deploy.sh', '--remote', 'unknown'], { encoding: 'utf8' });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('prepare/verify/commit/finalize/rollback');
    expect(result.stderr).not.toContain('배포 환경 파일');
  });

  it.each(['scripts/deploy.sh', 'scripts/bootstrap.sh'])('%s의 Bash 문법을 검사한다', (file) => {
    const result = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('bootstrap은 변경된 provision 경로를 전송하고 실행한다', () => {
    const bootstrap = readFileSync('scripts/bootstrap.sh', 'utf8');
    expect(bootstrap).toContain('TARGET="${HOST:-}"');
    expect(bootstrap).toContain('${REPO_ROOT}/infra/provision.sh');
    expect(bootstrap).toContain('sudo sh ${REMOTE_DIR}/provision.sh');
    expect(bootstrap).not.toMatch(/bootstrap-app|provision-app|APP_HOST/);
    const result = spawnSync(bash, ['scripts/bootstrap.sh'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, HOST: '-invalid', DOMAIN: 'quant.example.com' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('운영 서버 주소 형식이 올바르지 않습니다');
  });
});
