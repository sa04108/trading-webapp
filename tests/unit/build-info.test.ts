import { afterEach, describe, expect, it } from 'vitest';
import { readGitCommitSha } from '../../src/server/shared/build-info.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalBuildGitSha = process.env.BUILD_GIT_SHA;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalBuildGitSha === undefined) delete process.env.BUILD_GIT_SHA;
  else process.env.BUILD_GIT_SHA = originalBuildGitSha;
});

describe('build release identity', () => {
  it('allows an environment SHA only outside production', () => {
    process.env.BUILD_GIT_SHA = 'test-release-sha';
    expect(readGitCommitSha('test')).toBe('test-release-sha');

    // 호출자가 schema 기본값으로 production을 선택한 경우에도 실제 process.env와
    // 무관하게 env SHA fallback을 닫아야 한다.
    process.env.NODE_ENV = 'development';
    expect(readGitCommitSha('production')).not.toBe('test-release-sha');
  });
});
