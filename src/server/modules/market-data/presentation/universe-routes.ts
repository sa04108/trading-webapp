import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  HistoricalCandidateDto,
  HistoricalUniversePreviewDto,
  UniverseSnapshotDetailDto,
  UniverseSnapshotSummaryDto,
} from '../../../../shared/schemas/historical-universe.js';
import { UniverseJoinError, type EligibleCandidate } from '../domain/historical-universe.js';
import { UnknownKrxClassificationError } from '../domain/krx-filter-policy.js';
import { UNIVERSE_SORT_KEYS } from '../../../../shared/schemas/universe-sort.js';
import {
  HistoricalUniverseDateError,
  PreviewExpiredError,
  SortValueUnavailableError,
  type HistoricalUniversePreview,
  type HistoricalUniverseService,
} from '../application/historical-universe-service.js';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  KrxQuotaError,
} from '../application/ports.js';
import {
  SnapshotSelectionError,
  SymbolIdentityConflictError,
  type UniverseSnapshotDetail,
  type UniverseSnapshotService,
  type UniverseSnapshotSummary,
} from '../application/universe-snapshot-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 계약·분류 오류의 원문은 KRX 응답 세부를 담을 수 있어 응답에 노출하지 않는다. */
const KRX_CONTRACT_FAILURE_MESSAGE = 'KRX 응답이 예상 계약과 다릅니다 — 로그를 확인하세요.';

const previewRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sortBy: z.enum(UNIVERSE_SORT_KEYS).default('MKTCAP'),
});

const createSnapshotSchema = z.object({
  previewId: z.string().min(1),
  standardCodes: z.array(z.string().min(1)).min(1).max(1000),
  selectionMethod: z.enum(['TOP_MARKET_CAP_N', 'MANUAL_FROM_KRX_SNAPSHOT']),
  selectionN: z.number().int().min(1).optional(),
});

function candidateDto(
  candidate: EligibleCandidate,
  sortValues: ReadonlyMap<string, string>,
): HistoricalCandidateDto {
  return {
    standardCode: candidate.standardCode,
    shortCode: candidate.shortCode,
    name: candidate.name,
    market: candidate.market,
    marketCapKrw: candidate.marketCapKrw === null ? null : candidate.marketCapKrw.toString(),
    sortValue: sortValues.get(candidate.standardCode) ?? null,
    rank: candidate.rank,
  };
}

function previewDto(preview: HistoricalUniversePreview): HistoricalUniversePreviewDto {
  return {
    previewId: preview.previewId,
    requestedDate: preview.requestedDate,
    effectiveTradingDate: preview.effectiveTradingDate,
    usableFromDate: preview.usableFromDate,
    usableFromRule: preview.usableFromRule,
    candidates: preview.set.candidates.map((candidate) => candidateDto(candidate, preview.set.sortValues)),
    rawCounts: preview.set.rawCounts,
    eligibleCount: preview.set.eligibleCount,
    unknownMarketCapCount: preview.set.unknownMarketCapCount,
    sortBy: preview.set.sortKey,
    unknownSortValueCount: preview.set.unknownSortValueCount,
    excludedByType: preview.set.excludedByType,
    attribution: '한국거래소 통계정보',
  };
}

function summaryDto(summary: UniverseSnapshotSummary): UniverseSnapshotSummaryDto {
  return {
    id: summary.id,
    sourceKind: summary.sourceKind,
    requestedDate: summary.requestedDate,
    effectiveTradingDate: summary.effectiveTradingDate,
    usableFromDate: summary.usableFromDate,
    selectionMethod: summary.selectionMethod,
    selectionN: summary.selectionN,
    selectedCount: summary.selectedCount,
    unknownMarketCapCount: summary.unknownMarketCapCount,
    createdAtMs: summary.createdAtMs,
  };
}

function detailDto(detail: UniverseSnapshotDetail): UniverseSnapshotDetailDto {
  return {
    ...summaryDto(detail),
    symbols: detail.symbols.map((symbol) => ({
      standardCode: symbol.standardCode,
      shortCode: symbol.shortCode,
      name: symbol.name,
      market: symbol.market,
      marketCapKrw: symbol.marketCapKrw,
      rank: symbol.rank,
    })),
    krxApprovalExpiryDate: detail.krxApprovalExpiryDate,
  };
}

/**
 * 알려진 도메인·포트 오류를 HTTP 상태·안전한 메시지로 옮긴다. KRX 계약·분류 오류는
 * KRX 원문 필드명·값을 담을 수 있어 502 에는 고정 문구만 내보낸다 — 상세는 여기서
 * 서버 로그로 남긴다. 어댑터는 성공만 로깅하고 domain 은 로거가 없어, 여기가
 * 이 오류들이 기록되는 유일한 지점이다.
 */
function mapKnownError(
  request: FastifyRequest,
  error: unknown,
): { readonly statusCode: number; readonly message: string } | null {
  if (error instanceof HistoricalUniverseDateError || error instanceof SnapshotSelectionError) {
    return { statusCode: 400, message: error.message };
  }
  if (
    error instanceof KrxNotConfiguredError
    || error instanceof KrxApprovalExpiredError
    || error instanceof PreviewExpiredError
    || error instanceof SymbolIdentityConflictError
  ) {
    return { statusCode: 409, message: error.message };
  }
  if (error instanceof KrxQuotaError) {
    return { statusCode: 429, message: error.message };
  }
  if (error instanceof SortValueUnavailableError) {
    return { statusCode: 502, message: error.message };
  }
  if (
    error instanceof KrxContractError
    || error instanceof UniverseJoinError
    || error instanceof UnknownKrxClassificationError
  ) {
    // 메시지에는 KRX 필드명·단축코드만 있고 인증키는 없다 (어댑터가 이미 제거) — 로깅 안전
    request.log.warn(
      { module: 'market-data', event: 'krx.universe.contract-failed', errName: error.name, errMessage: error.message },
      'KRX universe contract/join/classification failed',
    );
    return { statusCode: 502, message: KRX_CONTRACT_FAILURE_MESSAGE };
  }
  return null;
}

export interface KrxStatusReporter {
  readonly approvalExpiry: string | null;
  readonly todayCallCount: () => number;
}

export function registerUniverseRoutes(
  app: FastifyInstance,
  historicalUniverseService: HistoricalUniverseService,
  universeSnapshotService: UniverseSnapshotService,
  requireAuth: PreHandler,
  krxStatus: KrxStatusReporter,
): void {
  app.get('/universe/historical/status', { preHandler: requireAuth }, async () => {
    const availability = historicalUniverseService.availability();
    return {
      available: availability.available,
      reason: availability.reason,
      approvalExpiry: krxStatus.approvalExpiry,
      todayCallCount: krxStatus.todayCallCount(),
    };
  });

  app.post('/universe/historical/preview', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = previewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'date(YYYY-MM-DD)·sortBy 필드가 올바르지 않습니다' });
    }
    try {
      const preview = await historicalUniverseService.preview(parsed.data.date, parsed.data.sortBy);
      return previewDto(preview);
    } catch (error) {
      const mapped = mapKnownError(request, error);
      if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message });
      throw error;
    }
  });

  app.post('/universe/snapshots', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: '필드가 올바르지 않습니다 (previewId/standardCodes/selectionMethod/selectionN)' });
    }
    try {
      const snapshot = await universeSnapshotService.createFromPreview({
        previewId: parsed.data.previewId,
        selectedStandardCodes: parsed.data.standardCodes,
        selectionMethod: parsed.data.selectionMethod,
        selectionN: parsed.data.selectionN ?? null,
      });
      return reply.code(201).send({ snapshot: detailDto(snapshot) });
    } catch (error) {
      const mapped = mapKnownError(request, error);
      if (mapped) return reply.code(mapped.statusCode).send({ error: mapped.message });
      throw error;
    }
  });

  app.get('/universe/snapshots', { preHandler: requireAuth }, async () => ({
    snapshots: universeSnapshotService.listSnapshots().map(summaryDto),
  }));

  app.get('/universe/snapshots/:snapshotId', { preHandler: requireAuth }, async (request, reply) => {
    const { snapshotId } = request.params as { snapshotId: string };
    const snapshot = universeSnapshotService.getSnapshot(snapshotId);
    if (!snapshot) return reply.code(404).send({ error: '스냅샷을 찾을 수 없습니다' });
    return { snapshot: detailDto(snapshot) };
  });
}
