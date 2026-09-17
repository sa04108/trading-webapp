import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('server deployment naming', () => {
  it('uses server as the canonical remote deployment namespace', () => {
    const deploy = readFileSync('scripts/deploy.mjs', 'utf8');
    const example = readFileSync('deploy.env.example', 'utf8');

    expect(deploy).toContain('SERVER_HOST');
    expect(deploy).toContain('SERVER_SSH_USER');
    expect(deploy).toContain('stageServerDeployment');
    expect(deploy).toContain('runServerPhase');
    expect(deploy).toContain('APP_* 설정은 deprecated');
    expect(example).toContain('SERVER_HOST=');
    expect(example).not.toContain('APP_HOST=');
  });

  it('provides a server-named bootstrap entrypoint while keeping migration compatibility', () => {
    const bootstrap = readFileSync('scripts/bootstrap-server.sh', 'utf8');

    expect(bootstrap).toContain('SERVER_HOST');
    expect(bootstrap).toContain('APP_HOST는 deprecated');
    expect(bootstrap).toContain('bootstrap-app.sh');
  });
});
