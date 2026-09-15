import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateRuntimeVersions } from '../../scripts/build-runtime-versions.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const versionNames = [
  'agentVersion', 'collectionVersion', 'previewVersion', 'executionVersion', 'validationVersion',
] as const;
type VersionName = typeof versionNames[number];

interface BoundaryCase {
  name: string;
  overrides: Record<string, string>;
  changed: readonly VersionName[];
}

function read(file: string): string {
  return fs.readFileSync(path.join(repository, file), 'utf8');
}

/** 실제 파일은 보존하고 실행 코드 한 줄만 가상으로 바꾼다. */
function changeCode(file: string): Record<string, string> {
  return { [file]: `${read(file)}\nexport const runtimeBoundaryProbe = 'changed';\n` };
}

function changeCompilerOptions(file: string, options: Record<string, unknown>): Record<string, string> {
  const config = JSON.parse(read(file));
  return { [file]: JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, ...options } }) };
}

describe('실행 도메인 버전 경계', () => {
  it('관련 구현만 무효화하고 UI·인증·주석·타입 변경은 계산 버전을 유지한다', () => {
    const engine = 'src/runtime/modules/backtest/domain/engine.ts';
    const serverMigration = 'migrations/operations/0000_baseline.sql';
    const cases: BoundaryCase[] = [
      { name: '웹 UI', overrides: changeCode('src/web/main.tsx'), changed: [] },
      { name: '인증 서비스', overrides: changeCode('src/server/modules/auth/application/auth-service.ts'), changed: [] },
      { name: '인증 DB 스키마', overrides: changeCode('src/server/shared/db/auth-schema.ts'), changed: [] },
      {
        name: '서버 운영 DB 마이그레이션',
        overrides: { [serverMigration]: `${read(serverMigration)}\nCREATE INDEX runtime_boundary_probe ON users(username);\n` },
        changed: [],
      },
      {
        name: '에이전트 서비스 설치',
        overrides: changeCode('src/agent/install.ts'),
        changed: ['agentVersion'],
      },
      {
        name: 'DART 파서',
        overrides: changeCode('src/server/modules/facts/infrastructure/dart/dart-report-parser.ts'),
        changed: ['collectionVersion', 'previewVersion', 'validationVersion'],
      },
      {
        name: '기간 검증 서비스',
        overrides: changeCode('src/server/modules/backtest/application/period-validation-service.ts'),
        changed: ['validationVersion'],
      },
      {
        name: '백테스트 엔진',
        overrides: changeCode(engine),
        changed: ['agentVersion', 'executionVersion', 'validationVersion'],
      },
      {
        name: '전략 구현',
        overrides: changeCode('src/runtime/modules/strategy/strategies/range-breakout.ts'),
        changed: ['agentVersion', 'previewVersion', 'executionVersion', 'validationVersion'],
      },
      {
        name: '실행 파일 주석',
        overrides: { [engine]: `${read(engine)}\n// 주석 변경은 실행 결과에 영향을 주지 않는다.\n` },
        changed: [],
      },
      {
        name: '타입 전용 선언과 인증 의존성',
        overrides: {
          [engine]: `${read(engine)}\nimport type { AuthService as BoundaryAuthService } from '../../../../server/modules/auth/application/auth-service.js';\ntype BoundaryAuth = BoundaryAuthService;\n`,
        },
        changed: [],
      },
      {
        name: '서버와 에이전트가 상속하는 코드 생성 target',
        overrides: changeCompilerOptions('tsconfig.build.json', { target: 'ES2022' }),
        changed: versionNames,
      },
      {
        name: '소스맵 생성 설정',
        overrides: changeCompilerOptions('tsconfig.build.json', { sourceMap: false }),
        changed: [],
      },
      {
        name: '타입 검사 strict 설정',
        overrides: changeCompilerOptions('tsconfig.build.json', { strict: false }),
        changed: [],
      },
      {
        name: '테스트 파일 include 설정',
        overrides: {
          'tsconfig.build.json': JSON.stringify({
            ...JSON.parse(read('tsconfig.build.json')),
            include: ['src/server', 'src/runtime', 'src/workers', 'src/agent', 'src/shared', 'tests'],
          }),
        },
        changed: [],
      },
    ];
    const baseline = generateRuntimeVersions(repository);
    for (const testCase of cases) {
      const changed = generateRuntimeVersions(repository, testCase.overrides);
      expect.soft(
        versionNames.filter((name) => baseline[name] !== changed[name]),
        testCase.name,
      ).toEqual(testCase.changed);
    }
  }, 60_000);

  it('에이전트만 다른 코드 생성 설정을 사용하면 생성을 거부한다', () => {
    expect(() => generateRuntimeVersions(
      repository,
      changeCompilerOptions('tsconfig.agent.json', { target: 'ES2022' }),
    )).toThrow('서버와 agent의 코드 생성 설정은 같아야 합니다');
  });
});
