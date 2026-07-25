import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 배포 산출물의 git 커밋 SHA (재현성 §9.5).
 * deploy.sh 가 빌드 후 dist/build-info.json 에 기록하고 런타임에 읽는다 —
 * env 는 개발 환경 fallback 이다.
 */
export function readGitCommitSha(): string {
  if (process.env.BUILD_GIT_SHA) return process.env.BUILD_GIT_SHA;

  const candidates = [
    // dist/server/shared/build-info.js → dist/build-info.json
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build-info.json'),
    path.resolve(process.cwd(), 'dist', 'build-info.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { gitSha?: string };
      if (parsed.gitSha) return parsed.gitSha;
    } catch {
      // 다음 후보 시도
    }
  }
  return 'unknown';
}
