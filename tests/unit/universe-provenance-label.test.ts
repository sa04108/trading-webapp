import { describe, expect, it } from 'vitest';
import {
  krxFixedUniverseBadge,
  provenanceNotice,
  selectionMethodLabel,
  universeSourceLabel,
} from '../../src/web/features/backtests/universe-provenance.js';
import { DATASET_TIMEPOINT_WARNING } from '../../src/shared/schemas/provenance-pin.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';

const krxPin: ProvenancePin = {
  sourceKind: 'KRX_HISTORICAL',
  universeSnapshotId: 'snap_1',
  requestedDate: '2024-12-30',
  effectiveTradingDate: '2024-12-30',
  usableFromDate: '2024-12-31',
  filterPolicyVersion: 'v1',
  selectionMethod: 'TOP_MARKET_CAP_N',
  selectionHash: 'hash',
  krxApprovalExpiryDate: null,
  approvalValidAtSubmit: true,
  timepointWarning: null,
  symbols: [],
};

const datasetPin: ProvenancePin = {
  sourceKind: 'DATASET',
  universeSnapshotId: null,
  requestedDate: null,
  effectiveTradingDate: null,
  usableFromDate: null,
  filterPolicyVersion: null,
  selectionMethod: null,
  selectionHash: null,
  krxApprovalExpiryDate: null,
  approvalValidAtSubmit: null,
  timepointWarning: DATASET_TIMEPOINT_WARNING,
  symbols: null,
};

describe('provenanceNotice', () => {
  it('KRX 스냅샷 실행은 고정 유니버스 문장을 만든다', () => {
    const notice = provenanceNotice(krxPin);
    expect(notice.sentence).toBe(
      '이 실행은 2024-12-30의 KRX 종목·시가총액으로 구성한 고정 유니버스를 전체 ' +
        '기간에 사용했습니다. 기간 중 시가총액 재산정이나 종목 편입·편출은 수행하지 ' +
        '않았습니다.',
    );
    expect(notice.warning).toBeNull();
  });

  it('데이터셋 실행은 시점 확인 불가 경고를 만든다', () => {
    const notice = provenanceNotice(datasetPin);
    expect(notice.warning).toBe(DATASET_TIMEPOINT_WARNING);
    expect(notice.sentence).toBeNull();
  });

  it('배지: KRX {적용일} 기준·고정 유니버스', () => {
    const notice = provenanceNotice(krxPin);
    expect(notice.badges).toEqual(['KRX 2024-12-30 기준·고정 유니버스']);
  });

  it('배지 문구는 krxFixedUniverseBadge 와 같은 값이다 — 위저드 검토 단계가 같은 함수로 만든다', () => {
    const notice = provenanceNotice(krxPin);
    expect(notice.badges).toEqual([krxFixedUniverseBadge(krxPin.effectiveTradingDate)]);
  });

  it('pin 이 없으면 배지·문장·경고를 모두 비운다', () => {
    expect(provenanceNotice(null)).toEqual({ badges: [], sentence: null, warning: null });
  });

  it('생존자 편향 제거 문구는 어디에도 없다', () => {
    for (const notice of [provenanceNotice(krxPin), provenanceNotice(datasetPin)]) {
      for (const text of [...notice.badges, notice.sentence, notice.warning]) {
        if (text !== null) expect(text).not.toContain('생존자 편향 제거');
      }
    }
  });
});

describe('krxFixedUniverseBadge', () => {
  it('적용일을 채워 「KRX {날짜} 기준·고정 유니버스」를 만든다', () => {
    expect(krxFixedUniverseBadge('2024-12-30')).toBe('KRX 2024-12-30 기준·고정 유니버스');
  });

  it('적용일이 없으면 「알 수 없는 날짜」로 채운다', () => {
    expect(krxFixedUniverseBadge(null)).toBe('KRX 알 수 없는 날짜 기준·고정 유니버스');
  });
});

describe('universeSourceLabel', () => {
  it('KRX 스냅샷이면 적용일을 포함한 라벨을 만든다', () => {
    expect(universeSourceLabel(krxPin)).toBe('KRX 2024-12-30 스냅샷');
  });

  it('데이터셋이면 「데이터셋」이라고만 적는다', () => {
    expect(universeSourceLabel(datasetPin)).toBe('데이터셋');
  });

  it('pin 이 없으면 데이터셋으로 취급한다', () => {
    expect(universeSourceLabel(null)).toBe('데이터셋');
  });
});

describe('selectionMethodLabel', () => {
  it('TOP_MARKET_CAP_N 을 사람이 읽는 문구로 바꾼다', () => {
    expect(selectionMethodLabel('TOP_MARKET_CAP_N')).toBe('시가총액 상위 N종목');
  });

  it('MANUAL_FROM_KRX_SNAPSHOT 을 수동 선택으로 바꾼다', () => {
    expect(selectionMethodLabel('MANUAL_FROM_KRX_SNAPSHOT')).toBe('수동 선택');
  });

  it('null 이면 - 를 적는다', () => {
    expect(selectionMethodLabel(null)).toBe('-');
  });
});
