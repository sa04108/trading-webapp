import { describe, expect, it } from 'vitest';
import { calculateResources } from '../../src/agent/resources.js';
import { agentSettingsSchema } from '../../src/agent/config.js';
const GIB = 1024 ** 3;

describe('에이전트 자동 자원 배정', () => {
  it('첫 작업은 하나만 관찰하고 큰 장치에서는 기존 200만 봉보다 큰 작업을 수용한다', () => {
    const result = calculateResources({ cpus: 32, total: 64 * GIB, available: 55 * GIB, load: 0 }, 0, 0, false);
    expect(result.slots).toBe(1);
    expect(result.maxBars).toBeGreaterThan(2_000_000);
    expect(result.heapMb * 1024 ** 2).toBeLessThan(result.availableBytes);
    expect(result.reserveBytes).toBeGreaterThan(6 * GIB);
  });
  it('CPU와 관측 RSS를 모두 고려해 여러 자식 프로세스를 배정한다', () => {
    const sample = { cpus: 8, total: 16 * GIB, available: 12 * GIB, load: 2 };
    const small = calculateResources(sample, 2, 256 * 1024 ** 2);
    const large = calculateResources(sample, 2, 4 * GIB);
    expect(small.slots).toBe(8);
    expect(large.slots).toBeLessThan(small.slots);
    expect(large.slots).toBeGreaterThanOrEqual(2);
  });
  it('메모리 압력 때 기존 작업을 보존하고 새 작업을 받지 않는다', () => {
    const result = calculateResources({ cpus: 16, total: 8 * GIB, available: 300 * 1024 ** 2, load: 2 }, 2, GIB);
    expect(result.slots).toBe(2);
    expect(result.availableBytes).toBe(0);
  });
  it('큰 대기 작업이 있으면 병렬 슬롯을 줄여 한 작업에 필요한 메모리를 확보한다', () => {
    const sample = { cpus: 16, total: 32 * GIB, available: 28 * GIB, load: 0 };
    const normal = calculateResources(sample, 0, 512 * 1024 ** 2);
    const large = calculateResources(sample, 0, 512 * 1024 ** 2, true, 8_000_000);
    expect(large.slots).toBeLessThan(normal.slots);
    expect(large.maxBars).toBeGreaterThanOrEqual(8_000_000);
  });
  it('설정은 서버 주소와 장치 토큰만 받는다', () => {
    const settings = { serverUrl: 'https://quant.example.com', token: 'a'.repeat(48) };
    expect(agentSettingsSchema.safeParse(settings).success).toBe(true);
    expect(agentSettingsSchema.safeParse({ ...settings, cpus: 8 }).success).toBe(false);
    expect(agentSettingsSchema.safeParse({ ...settings, serverUrl: 'http://quant.example.com' }).success).toBe(false);
  });
});
