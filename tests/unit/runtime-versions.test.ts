import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRuntimeVersions, type RuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';

const source = fileURLToPath(new URL('../../src/runtime/shared/runtime-versions.ts', import.meta.url));
const compiledReader = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  fileName: source,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const directories: string[] = [];
const versionNames = ['agentVersion', 'collectionVersion', 'previewVersion', 'executionVersion', 'validationVersion'] as const;

function versions(character: string): RuntimeVersions {
  return {
    schemaVersion: 1,
    agentVersion: character.repeat(64),
    collectionVersion: character.repeat(64),
    previewVersion: character.repeat(64),
    executionVersion: character.repeat(64),
    validationVersion: character.repeat(64),
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** 저장소 산출물은 건드리지 않고 배포 JS와 외부 작업 디렉터리를 격리한다. */
function packagedReader(metadata?: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-runtime-versions-'));
  directories.push(directory);
  const installed = path.join(directory, 'installed');
  const reader = path.join(installed, 'dist/runtime/shared/runtime-versions.js');
  fs.mkdirSync(path.dirname(reader), { recursive: true });
  fs.writeFileSync(reader, compiledReader);
  writeJson(path.join(installed, 'package.json'), { type: 'module' });
  if (metadata !== undefined) writeJson(path.join(installed, 'dist/runtime-versions.json'), metadata);
  writeJson(path.join(installed, 'dist/build-info.json'), { gitSha: 'd'.repeat(40) });

  const cwd = path.join(directory, 'other-checkout');
  writeJson(path.join(cwd, 'runtime-versions.json'), versions('b'));
  writeJson(path.join(cwd, 'dist/runtime-versions.json'), versions('b'));
  writeJson(path.join(cwd, 'dist/build-info.json'), { gitSha: 'e'.repeat(40) });

  return (environment: 'production' | 'development' = 'production') => spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { readRuntimeVersions } from ${JSON.stringify(pathToFileURL(reader).href)};\nprocess.stdout.write(JSON.stringify(readRuntimeVersions()));`,
  ], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_ENV: environment,
      QUANT_SOURCE_RUNTIME_VERSIONS: JSON.stringify(versions('c')),
      BUILD_GIT_SHA: 'f'.repeat(40),
    },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('실행 버전 메타데이터 파싱', () => {
  it('다섯 도메인의 SHA-256 버전을 읽는다', () => {
    expect(parseRuntimeVersions(versions('a'))).toEqual(versions('a'));
  });

  it.each([null, undefined, {}, [], 'a'.repeat(64), { ...versions('a'), schemaVersion: 2 }])(
    '올바르지 않은 메타데이터 형태 %j를 거부한다', (value) => {
      expect(() => parseRuntimeVersions(value)).toThrow('실행 버전 메타데이터가 없거나 올바르지 않습니다');
    },
  );

  it.each(versionNames)('%s가 누락되거나 SHA-256 형식이 아니면 거부한다', (name) => {
    for (const value of [undefined, null, 1, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)]) {
      expect(() => parseRuntimeVersions({ ...versions('a'), [name]: value })).toThrow('실행 버전 메타데이터가 없거나 올바르지 않습니다');
    }
  });
});

describe('배포된 실행 버전 읽기', () => {
  it.each(['production', 'development'] as const)(
    '%s에서도 cwd·소스 환경값·빌드 SHA와 무관하게 자기 dist 메타데이터를 읽는다', (environment) => {
      const result = packagedReader(versions('a'))(environment);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(versions('a'));
    },
  );

  it('자기 메타데이터가 없으면 다른 cwd나 소스 환경값이 유효해도 거부한다', () => {
    const result = packagedReader()();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('runtime-versions.json');
  });

  it('자기 메타데이터가 손상되면 다른 유효한 버전으로 대체하지 않는다', () => {
    const result = packagedReader({ ...versions('a'), validationVersion: 'invalid' })();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('실행 버전 메타데이터가 없거나 올바르지 않습니다');
  });
});
