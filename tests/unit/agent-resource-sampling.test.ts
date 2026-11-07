import fs from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableResources } from '../../src/agent/resources.js';

const MIB = 1024 ** 2;
const ROOT = '/sys/fs/cgroup';
const CHILD = `${ROOT}/service/agent`;
const PARENT = `${ROOT}/service`;

type Files = Record<string, string>;

function stat(inactive: number, dirty: number, writeback: number, active = 0, mapped = 0): string {
  return `inactive_file ${inactive}\nactive_file ${active}\nfile_dirty ${dirty}\nfile_writeback ${writeback}\nfile_mapped ${mapped}\n`;
}

function sample(
  files: Files,
  server = true,
  processAvailable = 2 * 1024 * MIB,
  constrainedMemory = 0,
  hostMemory = 2 * 1024 * MIB,
) {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor) => {
    const value = files[String(file)];
    if (value === undefined) throw new Error(`missing fixture: ${file}`);
    return value;
  }) as never);
  vi.spyOn(os, 'availableParallelism').mockReturnValue(2);
  vi.spyOn(os, 'totalmem').mockReturnValue(hostMemory);
  vi.spyOn(os, 'freemem').mockReturnValue(hostMemory);
  vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
  vi.spyOn(process, 'availableMemory').mockReturnValue(processAvailable);
  vi.spyOn(process, 'constrainedMemory').mockReturnValue(constrainedMemory);
  vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(192 * MIB);
  return availableResources(0, 0, true, 0, server);
}

function cgroupFiles(overrides: Files = {}): Files {
  return {
    '/proc/meminfo': 'MemAvailable:       2097152 kB\n',
    '/proc/self/cgroup': '0::/service/agent\n',
    [`${CHILD}/cpu.max`]: 'max 100000\n',
    [`${CHILD}/memory.max`]: `${640 * MIB}\n`,
    [`${CHILD}/memory.high`]: `${512 * MIB}\n`,
    [`${CHILD}/memory.current`]: `${500 * MIB}\n`,
    [`${CHILD}/memory.stat`]: stat(300 * MIB, 16 * MIB, 8 * MIB),
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('에이전트 cgroup 자원 샘플링', () => {
  it('high/max와 파일 캐시로 예산을 계산하고 Node의 high 여유를 중복 차감하지 않는다', () => {
    const result = sample(cgroupFiles(), true, 8 * MIB);

    expect(result.reserveBytes).toBe(64 * MIB);
    expect(result.slots).toBe(1);
    expect(result.availableBytes).toBe(224 * MIB);
    expect(result.budgetBytes).toBe(224 * MIB);
    expect(result.memoryPressure).toBe(false);
  });

  it.each(['5:memory:/service/agent\n', '0::/service/agent\n'])(
    '사용할 수 없는 cgroup 제한에서는 Node 측정값으로 보수적으로 막는다 (%s)',
    (cgroup) => {
      const files = cgroupFiles({ '/proc/self/cgroup': cgroup });
      delete files[`${CHILD}/memory.max`];
      delete files[`${CHILD}/memory.high`];
      delete files[`${CHILD}/memory.current`];
      delete files[`${CHILD}/memory.stat`];

      const result = sample(files, true, 32 * MIB, 640 * MIB, 8 * 1024 * MIB);

      expect(result.slots).toBe(0);
      expect(result.memoryPressure).toBe(true);
    },
  );

  it('상위 cgroup의 더 작은 memory.high도 현재 cgroup에 적용한다', () => {
    const result = sample(cgroupFiles({
      [`${PARENT}/memory.max`]: `${384 * MIB}\n`,
      [`${PARENT}/memory.high`]: `${256 * MIB}\n`,
      [`${PARENT}/memory.current`]: `${240 * MIB}\n`,
      [`${PARENT}/memory.stat`]: stat(0, 0, 0),
    }));

    expect(result.availableBytes).toBe(0);
    expect(result.slots).toBe(0);
    expect(result.memoryPressure).toBe(true);
  });

  it('0인 memory.high를 무제한으로 해석하지 않는다', () => {
    const result = sample(cgroupFiles({
      [`${CHILD}/memory.high`]: '0\n',
      [`${CHILD}/memory.current`]: '0\n',
      [`${CHILD}/memory.stat`]: stat(0, 0, 0),
    }));

    expect(result.budgetBytes).toBe(0);
    expect(result.memoryPressure).toBe(true);
  });

  it.each([true, false])('상위 그룹의 다른 서비스 캐시를 자신의 여유로 계산하지 않는다 (자체 한도: %s)', (ownLimit) => {
    const files = cgroupFiles({
      [`${CHILD}/memory.current`]: `${240 * MIB}\n`,
      [`${CHILD}/memory.stat`]: stat(20 * MIB, 0, 0),
      [`${PARENT}/memory.max`]: `${640 * MIB}\n`,
      [`${PARENT}/memory.high`]: `${640 * MIB}\n`,
      [`${PARENT}/memory.current`]: `${620 * MIB}\n`,
      [`${PARENT}/memory.stat`]: stat(20 * MIB, 0, 0, 360 * MIB),
    });
    if (!ownLimit) {
      files[`${CHILD}/memory.max`] = 'max';
      files[`${CHILD}/memory.high`] = 'max';
    }
    const result = sample(files);
    expect(result.memoryPressure).toBe(true);
    expect(result.slots).toBe(0);
  });

  it('필수 memory.stat 계수 하나라도 없거나 잘못되면 파일 캐시 여유를 더하지 않는다', () => {
    const result = sample(cgroupFiles({
      [`${CHILD}/memory.stat`]: `inactive_file ${300 * MIB}\nfile_dirty ${16 * MIB}\nfile_writeback bad\n`,
    }));

    expect(result.availableBytes).toBe(0);
    expect(result.memoryPressure).toBe(true);
  });

  it('깨끗한 스냅샷 캐시로 하드 여유가 작아져도 상주 메모리 여유가 있으면 실행한다', () => {
    const result = sample(cgroupFiles({
      [`${CHILD}/memory.current`]: `${600 * MIB}\n`,
      [`${CHILD}/memory.stat`]: stat(500 * MIB, 0, 0),
    }));

    expect(result.memoryPressure).toBe(false);
    expect(result.slots).toBe(1);
  });

  it('스냅샷 읽기 직후의 활성 캐시도 매핑되지 않고 깨끗하면 회수할 수 있다', () => {
    const result = sample(cgroupFiles({
      [`${CHILD}/memory.current`]: `${600 * MIB}\n`,
      [`${CHILD}/memory.stat`]: stat(20 * MIB, 4 * MIB, 0, 380 * MIB, 16 * MIB),
    }));
    expect(result.memoryPressure).toBe(false);
    expect(result.slots).toBe(1);
    expect(result.budgetBytes).toBe(228 * MIB);
  });

  it.each([
    stat(500 * MIB, 480 * MIB, 0),
    stat(20 * MIB, 0, 0, 480 * MIB, 480 * MIB),
    stat(500 * MIB, 0, 480 * MIB),
  ])('dirty·writeback·매핑 페이지 때문에 하드 여유가 64 MiB보다 작으면 실행하지 않는다 (%s)', (memoryStat) => {
    const result = sample(cgroupFiles({
      [`${CHILD}/memory.current`]: `${600 * MIB}\n`,
      [`${CHILD}/memory.stat`]: memoryStat,
    }));
    expect(result.memoryPressure).toBe(true);
    expect(result.slots).toBe(0);
  });

  it('원격 에이전트는 memory.high와 파일 캐시 공제를 적용하지 않는다', () => {
    const result = sample(cgroupFiles(), false);

    expect(result.reserveBytes).toBe(256 * MIB);
    expect(result.availableBytes).toBe(0);
    expect(result.memoryPressure).toBe(false);
  });
});
