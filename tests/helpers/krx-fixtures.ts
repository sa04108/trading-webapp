type KrxRawRow = Record<string, unknown>;

export function krxEnvelope(rows: readonly KrxRawRow[]): { OutBlock_1: readonly KrxRawRow[] } {
  return { OutBlock_1: rows };
}

export function krxJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function baseInfoFixture(overrides: KrxRawRow = {}): KrxRawRow {
  return {
    ISU_CD: 'KR7005930003',
    ISU_SRT_CD: '005930',
    ISU_NM: '삼성전자',
    LIST_DD: '19750611',
    MKT_TP_NM: 'KOSPI',
    SECUGRP_NM: '주권',
    SECT_TP_NM: '대형주',
    KIND_STKCERT_TP_NM: '보통주',
    ...overrides,
  };
}

export function dailyFixture(overrides: KrxRawRow = {}): KrxRawRow {
  return {
    ISU_CD: '005930',
    ISU_NM: '삼성전자',
    MKTCAP: '350,000,000,000,000',
    ...overrides,
  };
}
