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
  it('운영 서버는 CPU와 메모리 여유분을 더 남기고 포화 시 새 계산을 받지 않는다', () => {
    const sample = { cpus: 8, total: 16 * GIB, available: 12 * GIB, load: 0 };
    const remote = calculateResources(sample, 0);
    const local = calculateResources(sample, 0, 0, true, 0, true);
    expect(local.slots).toBeLessThan(remote.slots);
    expect(local.reserveBytes).toBe(8 * GIB);
    expect(calculateResources({ ...sample, load: 8 }, 0, 0, true, 0, true).slots).toBe(0);
    expect(calculateResources({ ...sample, available: GIB }, 1, 0, true, 0, true).slots).toBe(1);
  });
  it('512 MiB 운영 ceiling에서 API 여유를 남기고 로컬 워커 하나에 256 MiB를 준다', () => {
    const MIB = 1024 ** 2;
    const sample = {
      cpus: 2, total: 512 * MIB, available: 320 * MIB, load: 0,
      parentRss: 192 * MIB, hardAvailable: 448 * MIB,
    };
    const first = calculateResources(sample, 0, 0, false, 0, true);
    expect(first.reserveBytes).toBe(64 * MIB);
    expect(first.slots).toBe(1);
    expect(first.budgetBytes).toBe(256 * MIB);
    expect(first.heapMb).toBe(166);
    // 종료 유예 중인 기존 작업도 slot에서 빼지 않는다.
    expect(calculateResources(sample, 1, 184 * MIB, true, 0, true).slots).toBe(1);
    // 과거 RSS는 재사용하지 않아도 현재 요청의 봉 수는 admission에 반영한다.
    const largeRequest = calculateResources(sample, 0, 184 * MIB, true, 300_000, true);
    expect(largeRequest.slots).toBe(0);
    expect(largeRequest.budgetBytes).toBe(256 * MIB);
  });
  it('1 GiB 서버는 부모 절반을 보전하고 CPU 수와 무관하게 로컬 워커 하나만 허용한다', () => {
    const MIB = 1024 ** 2;
    const result = calculateResources({
      cpus: 8, total: 1024 * MIB, available: 768 * MIB, load: 0,
      parentRss: 192 * MIB,
    }, 0, 0, false, 0, true);
    expect(result.reserveBytes).toBe(320 * MIB);
    expect(result.budgetBytes).toBe(448 * MIB);
    expect(result.heapMb).toBe(291);
    expect(result.slots).toBe(1);
    expect(result.memoryPressure).toBe(false);
  });
  it('부모가 절반을 넘거나 effective/hard 가용량이 하한 아래면 새 로컬 작업을 막는다', () => {
    const MIB = 1024 ** 2;
    const parentHeavy = calculateResources({
      cpus: 2, total: 1024 * MIB, available: 700 * MIB, load: 0,
      parentRss: 512 * MIB,
    }, 0, 0, true, 0, true);
    const lowAvailable = calculateResources({
      cpus: 2, total: 1024 * MIB, available: 31 * MIB, load: 0,
      parentRss: 128 * MIB,
    }, 0, 0, true, 0, true);
    const lowHardAvailable = calculateResources({
      cpus: 2, total: 1024 * MIB, available: 700 * MIB, load: 0,
      parentRss: 128 * MIB, hardAvailable: 63 * MIB,
    }, 0, 0, true, 0, true);
    expect(parentHeavy.memoryPressure).toBe(true);
    expect(parentHeavy.slots).toBe(0);
    expect(lowAvailable.memoryPressure).toBe(true);
    expect(lowAvailable.slots).toBe(0);
    expect(lowHardAvailable.memoryPressure).toBe(true);
    expect(lowHardAvailable.slots).toBe(0);
  });
  it('지난 로컬 워커 RSS는 다음 작업의 admission 예측에 재사용하지 않는다', () => {
    const MIB = 1024 ** 2;
    const result = calculateResources({
      cpus: 2, total: 512 * MIB, available: 400 * MIB, load: 0,
      parentRss: 128 * MIB,
    }, 0, 280 * MIB, true, 0, true);
    expect(result.slots).toBe(1);
    expect(result.budgetBytes).toBe(256 * MIB);
  });
  it('원격 에이전트 정책은 부모 RSS나 서버 한 작업 제한의 영향을 받지 않는다', () => {
    const MIB = 1024 ** 2;
    const result = calculateResources({
      cpus: 8, total: 1024 * MIB, available: 768 * MIB, load: 0,
      parentRss: 700 * MIB,
    }, 0, 0, true);
    expect(result.reserveBytes).toBe(256 * MIB);
    expect(result.slots).toBeGreaterThan(1);
    expect(result.memoryPressure).toBe(false);
  });
  it('설정은 서버 주소와 장치 토큰만 받는다', () => {
    const settings = { serverUrl: 'https://quant.example.com', token: 'a'.repeat(48) };
    expect(agentSettingsSchema.safeParse(settings).success).toBe(true);
    expect(agentSettingsSchema.safeParse({ ...settings, cpus: 8 }).success).toBe(false);
    expect(agentSettingsSchema.safeParse({ ...settings, serverUrl: 'http://quant.example.com' }).success).toBe(false);
  });
});
