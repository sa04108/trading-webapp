import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSafePinnedScheduleIdentityJson,
  assertSafePinnedScheduleIdentities,
  UnsafeBacktestSymbolIdentityError,
} from '../../src/server/modules/backtest/application/backtest-symbol-identity.js';
import type { SymbolIdentitySnapshot } from '../../src/server/modules/market-data/application/symbol-master-service.js';

const MODERN_SCHEDULE = [{
  rebalanceDate: '2025-01-02',
  effectiveTradingDate: '2025-01-02',
  symbols: ['000001'],
  members: [{ symbol: '000001', standardCode: 'KR7000000001' }],
  excludedNonTradingCount: 0,
}];

function safeDeps() {
  return {
    symbolMaster: {
      readIdentitySnapshot: vi.fn((): SymbolIdentitySnapshot => ({
        versions: [{
          shortCode: '000001',
          standardCode: 'KR7000000001',
          validFromDate: '2000-01-01',
          validToDate: null,
        }],
        registrations: [{ code: '000001', standardCode: 'KR7000000001' }],
        unregisteredFactShortCodes: [],
        uncoveredBarShortCodes: [],
      })),
    },
  };
}

describe('backtest pinned schedule identity guard', () => {
  it('modern members를 날짜가 있는 selection으로 전체 생애 검증한다', () => {
    const deps = safeDeps();

    expect(assertSafePinnedScheduleIdentities(MODERN_SCHEDULE, deps as never)).toEqual([{
      shortCode: '000001',
      standardCode: 'KR7000000001',
      effectiveDate: '2025-01-02',
    }]);
    expect(deps.symbolMaster.readIdentitySnapshot)
      .toHaveBeenCalledWith(['000001'], ['KR7000000001']);
  });

  it('symbols와 members가 다르면 SCD나 등록 저장소를 읽기 전에 실패한다', () => {
    const deps = safeDeps();
    const malformed = [{
      ...MODERN_SCHEDULE[0]!,
      members: [{ symbol: '000002', standardCode: 'KR7000000002' }],
    }];

    expect(() => assertSafePinnedScheduleIdentities(malformed, deps as never))
      .toThrow(/symbols와 identity members가 일치하지 않아/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('null인 저장 일정 항목은 운영 장애가 아니라 손상된 identity 일정으로 거부한다', () => {
    const deps = safeDeps();

    expect(() => assertSafePinnedScheduleIdentities([null] as never, deps as never))
      .toThrow(/일정 항목 형식이 올바르지 않아/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('전체 생애 단축코드 재사용을 구체적인 실행 차단 오류로 바꾼다', () => {
    const deps = safeDeps();
    deps.symbolMaster.readIdentitySnapshot.mockReturnValue({
      versions: [{
        shortCode: '000001',
        standardCode: 'KR7000000001',
        validFromDate: '2000-01-01',
        validToDate: null,
      }, {
        shortCode: '000001',
        standardCode: 'KR7999999999',
        validFromDate: '1990-01-01',
        validToDate: '2000-01-01',
      }],
      registrations: [{ code: '000001', standardCode: 'KR7000000001' }],
      unregisteredFactShortCodes: [],
      uncoveredBarShortCodes: [],
    });

    expect(() => assertSafePinnedScheduleIdentities(MODERN_SCHEDULE, deps as never))
      .toThrow(UnsafeBacktestSymbolIdentityError);
    expect(() => assertSafePinnedScheduleIdentities(MODERN_SCHEDULE, deps as never))
      .toThrow(/단축코드 000001.*여러 표준코드.*가격·공시.*실행을 차단/);
  });

  it('현재 등록 pair가 정확해도 SCD 구간 밖의 가격 봉이 있으면 차단한다', () => {
    const deps = safeDeps();
    deps.symbolMaster.readIdentitySnapshot.mockReturnValue({
      ...deps.symbolMaster.readIdentitySnapshot(),
      uncoveredBarShortCodes: ['000001'],
    });

    expect(() => assertSafePinnedScheduleIdentities(MODERN_SCHEDULE, deps as never))
      .toThrow(/SCD identity 유효구간 밖의 가격 봉/);
  });

  it('legacy 일정은 양방향 1:1 pair를 추론한 뒤 각 적용일 유효성까지 검사한다', () => {
    const deps = safeDeps();
    const legacy = [{
      rebalanceDate: '2025-01-02',
      effectiveTradingDate: '2025-01-02',
      symbols: ['000001'],
      excludedNonTradingCount: 0,
    }];

    assertSafePinnedScheduleIdentities(legacy, deps as never);

    expect(deps.symbolMaster.readIdentitySnapshot)
      .toHaveBeenCalledWith(['000001'], []);
  });

  it('일부 날짜의 빈 유니버스는 허용하되 남은 종목만 검증한다', () => {
    const deps = safeDeps();
    const schedule = [{
      rebalanceDate: '2025-01-01',
      effectiveTradingDate: '2025-01-01',
      symbols: [],
      members: [],
      excludedNonTradingCount: 0,
    }, ...MODERN_SCHEDULE];

    expect(assertSafePinnedScheduleIdentities(schedule, deps as never)).toEqual([{
      shortCode: '000001',
      standardCode: 'KR7000000001',
      effectiveDate: '2025-01-02',
    }]);
  });

  it('전체 일정이 비어 있으면 identity를 고정할 수 없어 차단한다', () => {
    const deps = safeDeps();
    const schedule = [{
      rebalanceDate: '2025-01-01',
      effectiveTradingDate: '2025-01-01',
      symbols: [],
      members: [],
      excludedNonTradingCount: 0,
    }];

    expect(() => assertSafePinnedScheduleIdentities(schedule, deps as never))
      .toThrow(/일정 전체가 비어 있어/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('존재하지 않는 적용 거래일은 SCD를 읽기 전에 차단한다', () => {
    const deps = safeDeps();
    const malformed = [{ ...MODERN_SCHEDULE[0]!, effectiveTradingDate: '2025-02-30' }];

    expect(() => assertSafePinnedScheduleIdentities(malformed, deps as never))
      .toThrow(/적용 거래일.*올바르지 않습니다/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('리밸런스 날짜가 손상되면 NaN timestamp로 실행하기 전에 차단한다', () => {
    const deps = safeDeps();
    const malformed = [{ ...MODERN_SCHEDULE[0]!, rebalanceDate: 'broken' }];

    expect(() => assertSafePinnedScheduleIdentities(malformed, deps as never))
      .toThrow(/리밸런스 날짜가 올바르지 않습니다/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('JSON에서 변조된 비문자 적용일도 일반 오류가 아니라 unsafe 입력으로 차단한다', () => {
    const deps = safeDeps();
    const malformed = [{
      ...MODERN_SCHEDULE[0]!,
      effectiveTradingDate: { toString: null },
    }];

    expect(() => assertSafePinnedScheduleIdentities(malformed as never, deps as never))
      .toThrow(UnsafeBacktestSymbolIdentityError);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('저장 일정 JSON이 provenance hash와 달라지면 SCD 조회 전에 차단한다', () => {
    const deps = safeDeps();
    const originalHash = createHash('sha256')
      .update(JSON.stringify(MODERN_SCHEDULE))
      .digest('hex');
    const changed = [{ ...MODERN_SCHEDULE[0]!, rebalanceDate: '2025-02-03' }];

    expect(() => assertSafePinnedScheduleIdentityJson(
      JSON.stringify(changed),
      deps as never,
      { expectedScheduleHash: originalHash },
    )).toThrow(/provenance hash와 일치하지 않습니다/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });

  it('provenance pin이 있는데 scheduleHash가 빠진 손상도 fail-closed한다', () => {
    const deps = safeDeps();

    expect(() => assertSafePinnedScheduleIdentityJson(
      JSON.stringify(MODERN_SCHEDULE),
      deps as never,
      { expectedScheduleHash: undefined },
    )).toThrow(/hash 형식이 올바르지 않습니다/);
    expect(deps.symbolMaster.readIdentitySnapshot).not.toHaveBeenCalled();
  });
});
