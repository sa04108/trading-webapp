import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 배포 산출물의 git 커밋 SHA (재현성 §9.5).
 * deploy.sh 가 빌드 후 dist/build-info.json 에 기록하고 런타임에 읽는다 —
 * env 는 개발 환경 fallback 이다.
 */
export function readGitCommitSha(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  // 테스트·소스 실행만 env fallback을 허용한다. production에서 env가 파일보다 먼저면
  // 실제 배포 바이트와 무관한 SHA를 주입해 server/worker release gate를 우회할 수 있다.
  if (nodeEnv !== 'production' && process.env.BUILD_GIT_SHA) {
    return process.env.BUILD_GIT_SHA;
  }

  const candidates = [
    // dist/server/shared/build-info.js → dist/build-info.json
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build-info.json'),
    path.resolve(process.cwd(), 'dist', 'build-info.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { gitSha?: string };
      if (parsed.gitSha && FULL_GIT_SHA.test(parsed.gitSha)) return parsed.gitSha;
    } catch {
      // 다음 후보 시도
    }
  }
  return 'unknown';
}
