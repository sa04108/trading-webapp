import { describe, expect, it } from 'vitest';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  KrxQuotaError,
} from '../../src/server/modules/market-data/application/ports.js';
import {
  KRX_CONTRACT_VERSION,
  parseBaseInfoRows,
  parseDailyRows,
  parseKrxEnvelope,
  parseNullableInt64,
} from '../../src/server/modules/market-data/infrastructure/krx/krx-contract.js';
import { baseInfoFixture, dailyFixture } from '../helpers/krx-fixtures.js';

describe('KRX 응답 계약', () => {
  it('계약 버전은 v1 이다', () => {
    expect(KRX_CONTRACT_VERSION).toBe('v1');
  });
});

describe('parseNullableInt64', () => {
  it('빈 문자열과 - 는 null 이다', () => {
    expect(parseNullableInt64('', 'MKTCAP')).toBeNull();
    expect(parseNullableInt64('-', 'MKTCAP')).toBeNull();
    expect(parseNullableInt64(null, 'MKTCAP')).toBeNull();
  });

  it('콤마 구분 정수를 BigInt 로 파싱한다', () => {
    expect(parseNullableInt64('350,000,000,000,000', 'MKTCAP')).toBe(350_000_000_000_000n);
  });

  it('비정수·음수·64비트 초과는 KrxContractError 다', () => {
    expect(() => parseNullableInt64('12.5', 'MKTCAP')).toThrow(KrxContractError);
    expect(() => parseNullableInt64('-3', 'MKTCAP')).toThrow(KrxContractError);
    expect(() => parseNullableInt64('9223372036854775808', 'MKTCAP')).toThrow(KrxContractError);
  });

  it('형식 오류에는 필드와 사유를 담고 원문은 짧게 자른다', () => {
    const raw = `12x${'0'.repeat(40)}`;

    expect(() => parseNullableInt64(raw, 'MKTCAP')).toThrow(/MKTCAP.*정수 형식/);
    try {
      parseNullableInt64(raw, 'MKTCAP');
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual('MKTCAP 가 정수 형식이 아닙니다: '.length + 30);
    }
  });
});

describe('parseKrxEnvelope', () => {
  it('OutBlock_1 배열이 없으면 계약 오류다', () => {
    expect(() => parseKrxEnvelope({ resultCode: 'ERR' })).toThrow(KrxContractError);
  });

  it('여분 필드가 있어도 OutBlock_1 행을 꺼낸다', () => {
    const rows = parseKrxEnvelope({
      OutBlock_1: [baseInfoFixture({ UNEXPECTED_FIELD: '허용' })],
      resultCode: 'SUCCESS',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ISU_CD: 'KR7005930003', UNEXPECTED_FIELD: '허용' });
  });
});

describe('parseBaseInfoRows', () => {
  it('필수 필드가 빠지면 계약 오류다', () => {
    expect(() => parseBaseInfoRows([{ ISU_SRT_CD: '005930' }])).toThrow(KrxContractError);
  });

  it('정상 행을 내부 모델로 변환하고 원문을 보존한다', () => {
    const rows = parseBaseInfoRows([baseInfoFixture({ ISU_NM: '삼성전자', SECUGRP_NM: '주권' })]);
    expect(rows[0]!.securityGroupRaw).toBe('주권');
    expect(rows[0]!.standardCode).toBe('KR7005930003');
  });

  it('정상 LIST_DD 는 ISO 날짜로 바꾸고 형식이 다르면 null 로 둔다', () => {
    const [valid, malformed] = parseBaseInfoRows([
      baseInfoFixture({ LIST_DD: '20250102' }),
      baseInfoFixture({ LIST_DD: '2025-01-02' }),
    ]);

    expect(valid!.listedDate).toBe('2025-01-02');
    expect(malformed!.listedDate).toBeNull();
  });

  it('nullable 분류 필드는 없거나 null 이면 null 로 바꾼다', () => {
    const [absent, explicitNull] = parseBaseInfoRows([
      baseInfoFixture({ SECT_TP_NM: undefined, KIND_STKCERT_TP_NM: undefined }),
      baseInfoFixture({ SECT_TP_NM: null, KIND_STKCERT_TP_NM: null }),
    ]);

    expect(absent).toMatchObject({ sectionRaw: null, stockKindRaw: null });
    expect(explicitNull).toMatchObject({ sectionRaw: null, stockKindRaw: null });
  });

  it('LIST_SHRS 를 listedShares 정수 문자열로 파싱한다', () => {
    const rows = parseBaseInfoRows([{ ...baseInfoFixture(), LIST_SHRS: '5,969,782,550' }]);
    expect(rows[0]!.listedShares).toBe('5969782550');
  });

  it('LIST_SHRS 가 없거나 - 이면 null 이다', () => {
    const rows = parseBaseInfoRows([{ ...baseInfoFixture(), LIST_SHRS: '-' }]);
    expect(rows[0]!.listedShares).toBeNull();
  });
});

describe('parseDailyRows', () => {
  it('일별 행의 short code·이름·시가총액을 원문 손실 없이 옮긴다', () => {
    const [row] = parseDailyRows([dailyFixture({ MKTCAP: '350,000,000,000,000' })]);

    expect(row).toEqual({
      shortCode: '005930',
      name: '삼성전자',
      marketCapRaw: '350000000000000',
      open: 71_500,
      high: 72_000,
      low: 71_000,
      close: 71_800,
      volume: 12_345_678,
      tradingValueRaw: null,
    });
  });

  it('ACC_TRDVAL 거래대금 원문을 number 로 좁히지 않고 그대로 보존한다', () => {
    // `Number` 로 바꾸면 이 값은 이후 더 큰 실제 거래대금에서 정밀도를 잃는다.
    const [row] = parseDailyRows([{ ...dailyFixture(), ACC_TRDVAL: '123456789012345' }]);

    expect(row?.tradingValueRaw).toBe('123456789012345');
  });

  it('OHLCV 4개 가격과 거래량을 콤마 없는 숫자로 파싱한다', () => {
    const [row] = parseDailyRows([
      dailyFixture({
        TDD_OPNPRC: '71,500',
        TDD_HGPRC: '72,000',
        TDD_LWPRC: '71,000',
        TDD_CLSPRC: '71,800',
        ACC_TRDVOL: '12,345,678',
      }),
    ]);

    expect(row).toMatchObject({
      open: 71_500,
      high: 72_000,
      low: 71_000,
      close: 71_800,
      volume: 12_345_678,
    });
  });

  it('OHLCV 가 - 이면 null 이다 (휴장 직후·거래 정지 등)', () => {
    const [row] = parseDailyRows([
      dailyFixture({
        TDD_OPNPRC: '-',
        TDD_HGPRC: '-',
        TDD_LWPRC: '-',
        TDD_CLSPRC: '-',
        ACC_TRDVOL: '-',
      }),
    ]);

    expect(row).toMatchObject({ open: null, high: null, low: null, close: null, volume: null });
  });

  it('일별 시가총액의 null 과 - 는 null 로 둔다', () => {
    const [explicitNull, dash] = parseDailyRows([
      dailyFixture({ MKTCAP: null }),
      dailyFixture({ MKTCAP: '-' }),
    ]);

    expect(explicitNull!.marketCapRaw).toBeNull();
    expect(dash!.marketCapRaw).toBeNull();
  });

  it('일별 시가총액의 비정수·음수·64비트 초과는 계약 오류다', () => {
    for (const marketCap of ['12.5', '-3', '9223372036854775808']) {
      expect(() => parseDailyRows([dailyFixture({ MKTCAP: marketCap })])).toThrow(KrxContractError);
    }
  });
});

describe('KRX 포트 오류', () => {
  it('오류 이름을 일정하게 두고 미설정 오류는 승인 안내를 담는다', () => {
    const errors = [
      new KrxNotConfiguredError(),
      new KrxApprovalExpiredError(),
      new KrxContractError(),
      new KrxQuotaError(),
    ];

    expect(errors.map((error) => error.name)).toEqual([
      'KrxNotConfiguredError',
      'KrxApprovalExpiredError',
      'KrxContractError',
      'KrxQuotaError',
    ]);
    expect(errors[0]!.message).toMatch(/KRX Open API 키.*API별 승인/);
  });
});
