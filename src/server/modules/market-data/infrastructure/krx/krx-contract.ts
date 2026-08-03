import { z } from 'zod';
import { KrxContractError } from '../../application/ports.js';
import { basDdToIso } from '../../domain/kst-date.js';
import type { KrxDailyTradeRow, KrxIssueBaseInfoRow } from '../../domain/krx-universe-types.js';

export { KRX_CONTRACT_VERSION } from '../../domain/krx-universe-types.js';

const krxRecordSchema = z.object({}).loose();

const envelopeSchema = z.object({
  OutBlock_1: z.array(krxRecordSchema),
}).loose();

const baseInfoRowSchema = z.object({
  ISU_CD: z.string(),
  ISU_SRT_CD: z.string(),
  ISU_NM: z.string(),
  LIST_DD: z.string().nullable().optional(),
  MKT_TP_NM: z.string(),
  SECUGRP_NM: z.string(),
  SECT_TP_NM: z.string().nullable().optional(),
  KIND_STKCERT_TP_NM: z.string().nullable().optional(),
}).loose();

const dailyRowSchema = z.object({
  ISU_CD: z.string(),
  ISU_NM: z.string(),
  MKTCAP: z.string().nullable().optional(),
}).loose();

/** KRX 가 새 필드를 더해도 필수 응답 필드는 계약대로 검증한다. */
function contractErrorFromZod(context: string, error: z.ZodError): KrxContractError {
  const issue = error.issues[0];
  const field = issue?.path.join('.') || context;
  const reason = issue?.message ?? '응답 형식이 올바르지 않습니다';
  return new KrxContractError(`${field} 필드가 ${reason}`);
}

/** KRX envelope 에서 일별·기본정보 API 가 공통으로 쓰는 행 배열을 꺼낸다. */
export function parseKrxEnvelope(payload: unknown): readonly Record<string, unknown>[] {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw contractErrorFromZod('OutBlock_1', parsed.error);
  return parsed.data.OutBlock_1;
}

/** null 이 허용된 수치만 빈 값과 '-'를 모름으로 바꾼다. */
export function parseNullableInt64(raw: string | null | undefined, field: string): bigint | null {
  const trimmed = (raw ?? '').trim().replaceAll(',', '');
  if (trimmed === '' || trimmed === '-') return null;
  if (!/^\d+$/.test(trimmed)) {
    throw new KrxContractError(`${field} 가 정수 형식이 아닙니다: ${trimmed.slice(0, 30)}`);
  }
  const value = BigInt(trimmed);
  if (value > 2n ** 63n - 1n) {
    throw new KrxContractError(`${field} 가 64비트 범위를 넘습니다`);
  }
  return value;
}

/** 기본정보 행은 표시 원문을 유지하고 날짜만 안정적인 내부 형식으로 바꾼다. */
export function parseBaseInfoRows(rows: readonly Record<string, unknown>[]): KrxIssueBaseInfoRow[] {
  return rows.map((rawRow) => {
    const parsed = baseInfoRowSchema.safeParse(rawRow);
    if (!parsed.success) throw contractErrorFromZod('기본정보 행', parsed.error);

    const row = parsed.data;
    const listedDate = row.LIST_DD;
    return {
      standardCode: row.ISU_CD,
      shortCode: row.ISU_SRT_CD,
      name: row.ISU_NM,
      listedDate: listedDate !== undefined && listedDate !== null && /^\d{8}$/.test(listedDate)
        ? basDdToIso(listedDate)
        : null,
      marketRaw: row.MKT_TP_NM,
      securityGroupRaw: row.SECUGRP_NM,
      sectionRaw: row.SECT_TP_NM ?? null,
      stockKindRaw: row.KIND_STKCERT_TP_NM ?? null,
    };
  });
}

/** 시가총액은 Number 로 좁히지 않아 큰 값도 포트 경계에서 정확히 보존한다. */
export function parseDailyRows(rows: readonly Record<string, unknown>[]): KrxDailyTradeRow[] {
  return rows.map((rawRow) => {
    const parsed = dailyRowSchema.safeParse(rawRow);
    if (!parsed.success) throw contractErrorFromZod('일별 행', parsed.error);

    const row = parsed.data;
    const marketCap = parseNullableInt64(row.MKTCAP, 'MKTCAP');
    return {
      shortCode: row.ISU_CD,
      name: row.ISU_NM,
      marketCapRaw: marketCap === null ? null : marketCap.toString(),
    };
  });
}
