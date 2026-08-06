import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  SymbolMasterCoverageDto,
  SymbolMasterEntryDto,
  SymbolMasterEventDto,
  SymbolMasterSyncDto,
  SymbolMasterUniverseDto,
} from '../../../../shared/schemas/symbol-master.js';
import type { SymbolMasterEntry } from '../domain/symbol-master.js';
import { KrxNotConfiguredError, KrxQuotaError } from '../application/ports.js';
import type { SymbolMasterBackfill } from '../application/symbol-master-backfill.js';
import {
  SymbolMasterNotCoveredError,
  type SymbolMasterEventRow,
  type SymbolMasterService,
} from '../application/symbol-master-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 이벤트 목록 응답 상한 — 무제한 조회로 응답이 무한정 커지는 것을 막는다 */
const EVENTS_LIMIT = 500;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const universeQuerySchema = z.object({ date: dateSchema });
const eventsQuerySchema = z.object({ from: dateSchema, to: dateSchema });
const syncBodySchema = z.object({ date: dateSchema });
const backfillBodySchema = z.object({ fromDate: dateSchema, toDate: dateSchema.optional() });

function entryDto(entry: SymbolMasterEntry): SymbolMasterEntryDto {
  return {
    standardCode: entry.standardCode,
    shortCode: entry.shortCode,
    name: entry.name,
    market: entry.market,
    sharesOutstanding: entry.sharesOutstanding,
    instrumentType: entry.instrumentType,
    listedDate: entry.listedDate,
  };
}

function eventDto(row: SymbolMasterEventRow): SymbolMasterEventDto {
  return {
    id: row.id,
    effectiveDate: row.effectiveDate,
    standardCode: row.standardCode,
    eventType: row.eventType,
    oldValue: row.oldValue,
    newValue: row.newValue,
    observedSpanStart: row.observedSpanStart,
  };
}

export function registerSymbolMasterRoutes(
  app: FastifyInstance,
  deps: { service: SymbolMasterService; backfill: SymbolMasterBackfill },
  requireAuth: PreHandler,
): void {
  app.get('/symbol-master/universe', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = universeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'date(YYYY-MM-DD) 쿼리가 필요합니다' });
    }
    const { date } = parsed.data;

    // 미커버는 오류가 아니라 정상 응답이다 — 화면이 "아직 수집되지 않음" 을 표시할 수 있게
    // covered:false + 빈 배열로 답한다. isCovered 로 먼저 확인하니 getUniverseAsOf 는
    // SymbolMasterNotCoveredError 를 던지지 않는다.
    if (!deps.service.isCovered(date)) {
      const dto: SymbolMasterUniverseDto = { date, covered: false, symbols: [] };
      return dto;
    }

    const universe = deps.service.getUniverseAsOf(date);
    const dto: SymbolMasterUniverseDto = {
      date,
      covered: true,
      symbols: [...universe.values()].map(entryDto),
    };
    return dto;
  });

  app.get('/symbol-master/coverage', { preHandler: requireAuth }, async () => {
    const ranges = deps.service.coverageRanges();
    const checkpoints = deps.service.listCheckpoints();
    const backfillStatus = deps.backfill.status();

    // 구간이 하나도 없으면 동기화된 적이 없다는 뜻 — null 로 답한다.
    const lastSyncedAtMs =
      ranges.length === 0 ? null : Math.max(...ranges.map((range) => range.syncedAtMs));

    const dto: SymbolMasterCoverageDto = {
      ranges: ranges.map(({ startDate, endDate }) => ({ startDate, endDate })),
      checkpoints,
      lastSyncedAtMs,
      backfill: {
        state: backfillStatus.state,
        cursorDate: backfillStatus.cursorDate,
        targetStartDate: backfillStatus.targetStartDate,
        targetEndDate: backfillStatus.targetEndDate,
        error: backfillStatus.error,
      },
    };
    return dto;
  });

  app.get('/symbol-master/events', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'from/to(YYYY-MM-DD) 쿼리가 필요합니다' });
    }
    const { from, to } = parsed.data;

    // listEvents 는 effectiveDate·id 오름차순으로 준다 — API 계약(내림차순·최대 500행)에
    // 맞추려 뒤집고 자른다. 재구성 로직(eventsBetween)이 쓰는 순서를 건드리지 않으려
    // 여기서 후처리한다.
    const events = deps.service.listEvents(from, to);
    const descending = events.slice().reverse().slice(0, EVENTS_LIMIT);
    return { events: descending.map(eventDto) };
  });

  app.post('/symbol-master/sync', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = syncBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'date(YYYY-MM-DD) 필드가 필요합니다' });
    }
    try {
      // 휴장일 요청도 직전 거래일까지 소급 수집해 재구성 앵커를 보장한다 — ingestDate 만
      // 부르면 휴장일 응답이 앵커 없는 상태로 남아 이후 조회가 SymbolMasterNotCoveredError 로 샌다.
      const ensured = await deps.service.ensureTradingDay(parsed.data.date);
      const dto: SymbolMasterSyncDto = {
        requestedDate: ensured.requestedDate,
        effectiveTradingDate: ensured.effectiveTradingDate,
        ingestedDates: [...ensured.ingestedDates],
      };
      return dto;
    } catch (error) {
      if (error instanceof KrxQuotaError) {
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof KrxNotConfiguredError) {
        return reply.code(503).send({ error: error.message });
      }
      if (error instanceof SymbolMasterNotCoveredError) {
        return reply.code(409).send({ error: error.message });
      }
      // UnknownKrxClassificationError 등 나머지는 기본 오류 처리기(500)로 넘긴다.
      throw error;
    }
  });

  app.post('/symbol-master/backfill', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = backfillBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'fromDate(YYYY-MM-DD) 필드가 필요합니다' });
    }
    // start() 는 즉시 반환한다(fire-and-forget) — 백필은 분 단위로 걸릴 수 있어 응답을
    // 막아 세우지 않는다. toDate 를 생략하면 기존과 같이 오늘까지 채운다 — 위저드가
    // 백테스트 기간 전체(fromDate~toDate)만 수집하려 할 때 이 인자로 범위를 좁힌다.
    deps.backfill.start(parsed.data.fromDate, parsed.data.toDate);
    return reply.code(202).send(deps.backfill.status());
  });
}
