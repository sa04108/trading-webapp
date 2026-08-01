import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SYMBOL_CODE_PATTERN } from '../../../../shared/schemas/symbol-code.js';
import type { BrokerSyncService } from '../application/broker-sync-service.js';
import { SyncAlreadyRunningError } from '../application/broker-sync-service.js';
import type { DatasetService, FactsSyncEstimate } from '../application/dataset-service.js';
import type { SymbolService, SymbolSummary } from '../application/symbol-service.js';
import type { SymbolInfoService } from '../application/symbol-info-service.js';
import type { SymbolMetricsService } from '../application/symbol-metrics-service.js';
import { listMarketSupport } from '../domain/market-support.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const symbolSchema = z.string().regex(SYMBOL_CODE_PATTERN);

const importFieldsSchema = z.object({
  market: z.enum(['KR', 'US']),
  timeframe: z.enum(['1m', '1d']),
  symbol: symbolSchema,
});

/**
 * 종목 등록은 **항상 목록**을 받는다. 단건 등록과 일괄 등록을 라우트 둘로 나누면 이름
 * 조회·시장 검증·감사 기록이 두 곳에 생기고 한쪽만 고쳐진다 — 단건은 길이 1 목록이다.
 */
const addSymbolsSchema = z.object({
  codes: z.array(symbolSchema).min(1).max(1000),
  market: z.enum(['KR', 'US']),
});

const removeSymbolsSchema = z.object({
  codes: z.array(symbolSchema).min(1).max(1000),
});

const createDatasetSchema = z.object({
  name: z.string().min(1).max(64),
  symbols: z.array(symbolSchema).min(1).max(1000),
});

const syncSchema = z.object({
  /** 동기화할 종목 — 데이터셋이 아니라 종목 집합이 대상이다 */
  codes: z.array(symbolSchema).min(1).max(1000),
  slice: z.enum(['1m', '1d']).optional(),
  /** 재무(DART)까지 함께 수집할지. 기본은 봉만 */
  includeFacts: z.boolean().optional(),
});

const updateDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    addSymbols: z.array(symbolSchema).max(1000).optional(),
    removeSymbols: z.array(symbolSchema).max(1000).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      (body.addSymbols?.length ?? 0) + (body.removeSymbols?.length ?? 0) > 0,
    { message: '변경할 내용이 없습니다' },
  );

const MAX_CSV_BYTES = 50 * 1024 * 1024;

export function registerDatasetRoutes(
  app: FastifyInstance,
  datasetService: DatasetService,
  symbolService: SymbolService,
  brokerSyncService: BrokerSyncService,
  symbolInfoService: SymbolInfoService,
  symbolMetricsService: SymbolMetricsService,
  /** 이 데이터셋을 참조하는 활성 백테스트 존재 여부 — 조립부가 backtest 모듈로 연결한다 */
  hasActiveBacktests: (datasetId: string) => boolean,
  /** 재무 수집 예상 — 조립부가 facts 모듈로 연결한다 (market-data 는 facts 를 모른다) */
  factsSyncEstimator: (codes: readonly string[]) => FactsSyncEstimate,
  /**
   * 재무를 가진 종목 전체 — 같은 이유로 조립부가 연결한다. 있고 없음만 답한다:
   * 종목별·연도별로 얼마나 채워졌는지는 묻지 않는다 (D-033).
   *
   * 종목 하나씩 묻는 대신 집합을 받는 이유: 목록 응답이 종목마다 파일 시스템을 두드리면
   * 1,000종목에서 stat 1,000회가 되고 그 목록은 5초마다 다시 읽힌다.
   */
  symbolsWithFacts: () => ReadonlySet<string>,
  requireAuth: PreHandler,
): void {
  /**
   * 종목 화면이 쓰는 응답 = 종목 요약 + 재무 보유 여부. `SymbolSummary` 에 넣지 않는
   * 이유: 그 타입은 market-data 소관이고 재무는 facts 모듈 소관이다 (§7).
   *
   * 재무 집합을 인자로 받는다 — 요청당 한 번 읽어 목록 전체가 공유한다.
   */
  const withFacts = (summary: SymbolSummary, factCodes: ReadonlySet<string>) => ({
    ...summary,
    hasFacts: factCodes.has(summary.code),
  });

  /**
   * 표시명을 외부 조회로 채운다. 등록 경로가 둘이라(추가 dialog·CSV 가져오기) 한 곳에
   * 모아 둔다 — CSV 로 들어온 종목만 이름이 빈 채로 남으면 목록의 가나다순 정렬이
   * 그 종목들만 뒤로 몰아 놓는다. 조회 실패는 등록을 막지 않는다.
   *
   * 목록으로 한 번에 묻는다 — 종목마다 부르면 100종목 일괄 등록이 외부 호출 100번이 된다.
   */
  const resolveNames = async (codes: readonly string[]): Promise<Map<string, string>> => {
    try {
      const infos = await symbolInfoService.lookup(codes);
      return new Map(infos.filter((info) => info.name).map((info) => [info.symbol, info.name]));
    } catch {
      return new Map();
    }
  };

  const resolveName = async (code: string): Promise<string | null> =>
    (await resolveNames([code])).get(code) ?? null;

  /** 지원 시장 목록. 배포마다 고정이므로 클라이언트가 길게 캐시한다. */
  app.get('/markets', { preHandler: requireAuth }, async () => ({
    markets: listMarketSupport(),
  }));

  /** 종목 코드 → 이름. 소스 미설정이면 빈 목록 — UI 는 코드만으로도 동작한다. */
  app.get('/symbols/info', { preHandler: requireAuth }, async (request, reply) => {
    const raw = (request.query as { symbols?: string }).symbols ?? '';
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (symbols.length === 0 || symbols.length > 1000) {
      return reply.code(400).send({ error: 'symbols 쿼리가 필요합니다 (콤마 구분, 최대 1000)' });
    }
    try {
      return { stocks: await symbolInfoService.lookup(symbols) };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * 종목 정렬 지표 — 시가총액·거래대금·거래량. **등록된 종목 전체**를 답한다.
   *
   * 코드를 받지 않는 이유: 정렬은 페이지가 아니라 목록 전체를 대상으로 하고, 화면이
   * 페이지마다 다시 물으면 스크롤 중에 순서가 바뀐다. 한 번 받아 캐시하는 편이 맞다.
   *
   * 조회 실패는 200 + null 이다. 지표가 없다고 종목 화면이 막히면 안 된다 — 자격 증명
   * 미설정 환경에서도 가나다순 정렬로 목록은 그대로 쓸 수 있어야 한다.
   */
  app.get('/symbols/metrics', { preHandler: requireAuth }, async () => {
    const symbols = symbolService.listSymbols().map((summary) => ({
      code: summary.code,
      market: summary.market,
    }));
    return symbolMetricsService.getMetrics(symbols);
  });

  // ── 종목 ────────────────────────────────────────────────────────────

  /**
   * 종목 목록. 화면이 그리는 데 필요한 것을 한 번에 담는다 — 이름·봉 슬라이스별 보유·
   * 슬라이스별 마지막 수집·재무 보유·참조 데이터셋 수. 행마다 별도 조회를 내면 200종목에서
   * 요청이 폭발한다.
   */
  app.get('/symbols', { preHandler: requireAuth }, async () => {
    const factCodes = symbolsWithFacts();
    return {
      symbols: symbolService.listSymbols().map((summary) => withFacts(summary, factCodes)),
      runningSyncJobId: symbolService.runningSyncJobId(),
    };
  });

  /**
   * 종목 등록 (단건·일괄 공용). 이름은 여기서 외부 조회로 채운다 — 실패해도 등록은 진행한다.
   *
   * **부분 성공을 인정한다.** 20종목 중 3종목이 이미 등록돼 있을 때 전체를 되돌리면
   * 사용자가 목록에서 그 3개를 손으로 지우고 다시 붙여야 한다. 대신 무엇이 들어가고
   * 무엇이 빠졌는지를 응답에 적어 화면이 그대로 말하게 한다.
   *
   * 하나도 못 넣었으면 201 이 아니다 — 빈 성공을 돌려주면 화면이 "추가했습니다" 를
   * 띄우고 목록은 그대로인 상태가 된다.
   */
  app.post('/symbols', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = addSymbolsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (codes/market)' });
    }
    // 입력 순서를 지키며 중복만 걷어낸다 — 같은 코드를 두 번 붙였다고 실패시킬 이유가 없다
    const codes = [...new Set(parsed.data.codes)];
    const names = await resolveNames(codes);
    const factCodes = symbolsWithFacts();

    const added: Array<ReturnType<typeof withFacts>> = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    for (const code of codes) {
      try {
        added.push(
          withFacts(
            symbolService.addSymbol(code, parsed.data.market, names.get(code) ?? null),
            factCodes,
          ),
        );
      } catch (error) {
        skipped.push({ code, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (added.length === 0) {
      // 같은 이유가 수십 번 반복되므로 중복을 걷어내고 앞 몇 개만 남긴다
      const reasons = [...new Set(skipped.map((entry) => entry.reason))];
      const shown = reasons.slice(0, 3).join(' · ');
      const rest = reasons.length - 3;
      return reply
        .code(409)
        .send({ error: rest > 0 ? `${shown} 외 ${rest}건` : shown, added, skipped });
    }
    return reply.code(201).send({ added, skipped });
  });

  /**
   * 제거 영향 조회 — 확인 대화상자가 "어느 데이터셋이 영향받는지" 를 먼저 보여준다.
   * 제거 자체와 분리한 이유: 사용자가 결과를 보고 취소할 수 있어야 한다.
   */
  app.post('/symbols/removal-impact', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = removeSymbolsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'codes 가 필요합니다' });
    return { impacts: symbolService.removalImpact(parsed.data.codes) };
  });

  /** 종목 제거 — 봉·재무·참조를 함께 끊는다. 데이터셋을 비게 만드는 조합은 409 */
  app.post('/symbols/remove', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = removeSymbolsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'codes 가 필요합니다' });
    try {
      await symbolService.removeSymbols(parsed.data.codes);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('비게') || message.includes('실행 중') ? 409 : 400).send({
        error: message,
      });
    }
  });

  /** 종목 수집 예상 — 선택 집합 기준. 재무 체크박스를 잠글 근거도 여기서 온다 */
  app.get('/symbols/sync-estimate', { preHandler: requireAuth }, async (request, reply) => {
    const raw = (request.query as { codes?: string; slice?: string }).codes ?? '';
    const slice = ((request.query as { slice?: string }).slice ?? '1d') as '1m' | '1d';
    const codes = raw
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0);
    if (codes.length === 0) return reply.code(400).send({ error: 'codes 쿼리가 필요합니다' });
    const markets = new Set(
      symbolService.listSymbols().filter((s) => codes.includes(s.code)).map((s) => s.market),
    );
    return {
      candles: symbolService.getCandleSyncEstimate(codes, slice),
      facts: factsSyncEstimator(codes),
      minutePlan:
        markets.size === 1
          ? symbolService.getMinutePlan([...markets][0]!, codes.length)
          : null,
      note: '공휴일 캘린더 미반영: 공휴일이 누락 구간으로 보고될 수 있습니다.',
    };
  });

  /** 검증 차트용 캔들 조회 — 상한(2,000봉) 초과는 400 (다운샘플로 뭉개지 않는다) */
  app.get('/symbols/:code/candles', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const query = request.query as { timeframe?: string; fromTsMs?: string; toTsMs?: string };
    const fromTsMs = Number(query.fromTsMs);
    const toTsMs = Number(query.toTsMs);
    if (
      !['1m', '1h', '1d'].includes(query.timeframe ?? '') ||
      !Number.isFinite(fromTsMs) ||
      !Number.isFinite(toTsMs) ||
      toTsMs < fromTsMs
    ) {
      return reply.code(400).send({ error: 'timeframe/fromTsMs/toTsMs 쿼리가 필요합니다' });
    }
    if (!symbolService.exists(code)) {
      return reply.code(404).send({ error: '종목을 찾을 수 없습니다' });
    }
    try {
      return await symbolService.getCandlesForInspection(
        code,
        query.timeframe as '1m' | '1h' | '1d',
        fromTsMs,
        toTsMs,
      );
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * CSV import. multipart/form-data:
   *   fields: market, timeframe, symbol
   *   file:   csv (timestamp,open,high,low,close,volume)
   *
   * 데이터셋 이름을 받지 않는다 — 봉은 종목으로 들어가고, 없는 종목은 등록된다.
   */
  app.post('/symbols/import', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'multipart/form-data 요청이 필요합니다' });
    }

    const fields: Record<string, string> = {};
    let csvContent: string | null = null;
    let fileName: string | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (!part.filename.toLowerCase().endsWith('.csv')) {
          return reply.code(400).send({ error: 'CSV 파일만 지원합니다' });
        }
        fileName = part.filename;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          total += (chunk as Buffer).length;
          if (total > MAX_CSV_BYTES) {
            return reply.code(413).send({ error: '파일이 너무 큽니다 (최대 50MB)' });
          }
          chunks.push(chunk as Buffer);
        }
        csvContent = Buffer.concat(chunks).toString('utf8');
      } else {
        fields[part.fieldname] = part.value as string;
      }
    }

    const parsedFields = importFieldsSchema.safeParse(fields);
    if (!parsedFields.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (market/timeframe/symbol)' });
    }
    if (!csvContent || !fileName) {
      return reply.code(400).send({ error: 'CSV 파일이 필요합니다' });
    }

    let job: Awaited<ReturnType<SymbolService['importCsv']>>;
    try {
      job = await symbolService.importCsv({
        market: parsedFields.data.market,
        timeframe: parsedFields.data.timeframe,
        symbol: parsedFields.data.symbol,
        fileName,
        csvContent,
      });
    } catch (error) {
      // 세션 미지원 시장 등 job 생성 이전의 검증 실패
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }

    // 새로 등록된 종목이면 이름을 채운다 — 목록이 코드만 보여 주지 않게
    if (job.status !== 'FAILED') {
      const symbol = symbolService.getSymbol(parsedFields.data.symbol);
      if (symbol !== null && symbol.name === null) {
        symbolService.setName(parsedFields.data.symbol, await resolveName(symbol.code));
      }
    }
    return reply.code(job.status === 'FAILED' ? 422 : 201).send({ job });
  });

  /** 증권사 동기화 시작 — 202 + jobId, 진행은 GET /data-jobs/:jobId */
  app.post('/symbols/sync', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = syncSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'codes 가 필요합니다' });
    // 재무 단계는 봉 뒤에 온다 — 여기서 막지 않으면 45분 봉 수집을 끝낸 뒤에야
    // "DART 키가 없습니다" 로 실패한다
    if (parsed.data.includeFacts === true) {
      const estimate = factsSyncEstimator(parsed.data.codes);
      if (estimate.basis === 'UNSUPPORTED') {
        return reply.code(400).send({ error: estimate.reason });
      }
    }
    try {
      const { job } = brokerSyncService.startSync(parsed.data.codes, {
        slice: parsed.data.slice,
        includeFacts: parsed.data.includeFacts === true,
      });
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return reply.code(409).send({ error: error.message });
      }
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ── 데이터셋 (종목 참조 묶음) ───────────────────────────────────────

  app.get('/datasets', { preHandler: requireAuth }, async () => ({
    datasets: datasetService.listDatasets(),
  }));

  app.get('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    return dataset;
  });

  app.post('/datasets', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (name/symbols)' });
    }
    try {
      const dataset = datasetService.createDataset(parsed.data.name, parsed.data.symbols);
      return reply.code(201).send({ dataset });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 데이터셋 편집 — 이름 변경 + 종목 참조 편집 */
  app.patch('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const parsed = updateDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: '필드가 올바르지 않습니다 (name/addSymbols/removeSymbols)' });
    }
    if (!datasetService.getDataset(datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    try {
      // 이름을 먼저 검증·적용한다 — 중복 이름으로 거부될 요청이 종목만 바꾸고 끝나지 않게
      let dataset =
        parsed.data.name !== undefined
          ? datasetService.renameDataset(datasetId, parsed.data.name)
          : undefined;
      if ((parsed.data.addSymbols?.length ?? 0) + (parsed.data.removeSymbols?.length ?? 0) > 0) {
        dataset = datasetService.updateSymbols(datasetId, {
          add: parsed.data.addSymbols,
          remove: parsed.data.removeSymbols,
        });
      }
      return reply.send({ dataset });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 데이터셋 삭제 — **참조만** 끊는다. 봉·재무는 종목 소관이라 남는다 */
  app.delete('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    if (!datasetService.getDataset(datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    if (hasActiveBacktests(datasetId)) {
      return reply
        .code(409)
        .send({ error: '이 데이터셋을 참조하는 백테스트가 있습니다 — 완료·취소 후 삭제하세요' });
    }
    datasetService.deleteDataset(datasetId);
    return reply.code(204).send();
  });

  // ── 수집 잡 ─────────────────────────────────────────────────────────

  app.get('/data-jobs/:jobId', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = symbolService.getSyncJob(jobId);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return { job };
  });

  /** 실행 중 동기화 취소 — 페이지 경계에서 반영, 저장분은 남아 재실행이 이어받는다 */
  app.post('/data-jobs/:jobId/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = symbolService.getSyncJob(jobId);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    if (job.status !== 'RUNNING' && job.status !== 'QUEUED') {
      return reply.code(409).send({ error: '이미 종료된 작업입니다' });
    }
    const result = brokerSyncService.cancelSync(jobId);
    if (result === 'NOT_RUNNING') {
      // RUNNING 으로 남았지만 이 프로세스에 없다 — 재시작 고아. 부팅 정리와 같은 처리.
      return reply.code(409).send({
        error:
          '이 프로세스에서 실행 중인 작업이 아닙니다 — 서버 재시작으로 중단된 작업이면 자동 정리됩니다',
      });
    }
    return reply.code(202).send({ status: result });
  });
}
