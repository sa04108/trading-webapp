import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  BrokerSyncService} from '../application/broker-sync-service.js';
import {
  SyncAlreadyRunningError,
  SyncUnsupportedDatasetError,
} from '../application/broker-sync-service.js';
import type { DatasetService } from '../application/dataset-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const importFieldsSchema = z.object({
  datasetName: z.string().min(1).max(64),
  market: z.enum(['KR', 'US']),
  timeframe: z.enum(['1m', '1h']),
  symbol: z.string().regex(/^[A-Za-z0-9._-]{1,20}$/),
});

const createDatasetSchema = z.object({
  name: z.string().min(1).max(64),
  market: z.enum(['KR', 'US']),
  /** 수집 timeframe — 데이터셋 timeframe 은 1m→1h(사전 집계), 1d→1d 관례를 따른다 */
  collect: z.enum(['1m', '1d']),
  symbols: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/)).min(1).max(1000),
});

const syncSchema = z.object({ datasetId: z.string().min(1) });

const symbolSchema = z.string().regex(/^[A-Za-z0-9._-]{1,20}$/);
const updateSymbolsSchema = z
  .object({
    addSymbols: z.array(symbolSchema).max(1000).optional(),
    removeSymbols: z.array(symbolSchema).max(1000).optional(),
  })
  .refine((body) => (body.addSymbols?.length ?? 0) + (body.removeSymbols?.length ?? 0) > 0, {
    message: '변경할 심볼이 없습니다',
  });

const MAX_CSV_BYTES = 50 * 1024 * 1024;

export function registerDatasetRoutes(
  app: FastifyInstance,
  datasetService: DatasetService,
  brokerSyncService: BrokerSyncService,
  /** 이 데이터셋을 참조하는 활성 백테스트 존재 여부 — 조립부가 backtest 모듈로 연결한다 */
  hasActiveBacktests: (datasetId: string) => boolean,
  requireAuth: PreHandler,
): void {
  app.get('/datasets', { preHandler: requireAuth }, async () => ({
    datasets: datasetService.listDatasets(),
  }));

  app.get('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    return dataset;
  });

  app.get('/datasets/:datasetId/coverage', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    return {
      coverage: datasetService.getCoverage(datasetId).map((row) => ({
        symbol: row.symbol,
        firstTsMs: row.firstTsMs,
        lastTsMs: row.lastTsMs,
        barCount: row.barCount,
        expectedBarCount: row.expectedBarCount,
        missingRanges: row.missingRangesJson ? JSON.parse(row.missingRangesJson) : [],
        computedAtMs: row.computedAtMs,
      })),
      note: '공휴일 캘린더 미반영: 공휴일이 누락 구간으로 보고될 수 있습니다.',
    };
  });

  /**
   * CSV import. multipart/form-data:
   *   fields: datasetName, market, timeframe, symbol
   *   file:   csv (timestamp,open,high,low,close,volume)
   */
  app.post('/datasets/import', { preHandler: requireAuth }, async (request, reply) => {
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
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (datasetName/market/timeframe/symbol)' });
    }
    if (!csvContent || !fileName) {
      return reply.code(400).send({ error: 'CSV 파일이 필요합니다' });
    }
    // 포맷 검증은 parseCandleCsv 가 담당한다 (헤더·행 단위) — 여기서 중복 검사하지 않는다

    let job: Awaited<ReturnType<DatasetService['importCsv']>>;
    try {
      job = await datasetService.importCsv({
        datasetName: parsedFields.data.datasetName,
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

    return reply.code(job.status === 'FAILED' ? 422 : 201).send({ job });
  });

  /** 증권사 수집용 데이터셋 생성 (설계 2026-07-28-broker-sync-design.md) */
  app.post('/datasets', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createDatasetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (name/market/collect/symbols)' });
    }
    try {
      const dataset = datasetService.createBrokerDataset(
        parsed.data.name,
        parsed.data.market,
        parsed.data.collect,
        parsed.data.symbols,
      );
      return reply.code(201).send({ dataset });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 심볼 목록 편집 — 제거는 수집 중단 밸브, 기존 봉은 보존 */
  app.patch('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const parsed = updateSymbolsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (addSymbols/removeSymbols)' });
    }
    if (!datasetService.getDataset(datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    try {
      const dataset = datasetService.updateSymbols(datasetId, {
        add: parsed.data.addSymbols,
        remove: parsed.data.removeSymbols,
      });
      return reply.send({ dataset });
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 데이터셋 삭제 — 메타데이터 + 물리 Parquet. 참조 중인 작업이 있으면 409 */
  app.delete('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    if (!datasetService.getDataset(datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    if (hasActiveBacktests(datasetId)) {
      return reply.code(409).send({ error: '이 데이터셋을 참조하는 백테스트가 있습니다 — 완료·취소 후 삭제하세요' });
    }
    try {
      await datasetService.deleteDataset(datasetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('실행 중') ? 409 : 500).send({ error: message });
    }
    return reply.code(204).send();
  });

  /** 증권사 동기화 시작 — 202 + jobId, 진행은 GET /data-jobs/:jobId */
  app.post('/datasets/sync', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = syncSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'datasetId 가 필요합니다' });
    if (!datasetService.getDataset(parsed.data.datasetId)) {
      return reply.code(404).send({ error: '데이터셋을 찾을 수 없습니다' });
    }
    try {
      const { job } = brokerSyncService.startSync(parsed.data.datasetId);
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof SyncUnsupportedDatasetError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/data-jobs/:jobId', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = datasetService.getImportJob(jobId);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return { job };
  });

  /** 실행 중 동기화 취소 — 페이지 경계에서 반영, 저장분은 남아 재실행이 이어받는다 */
  app.post('/data-jobs/:jobId/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = datasetService.getImportJob(jobId);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    if (job.status !== 'RUNNING' && job.status !== 'QUEUED') {
      return reply.code(409).send({ error: '이미 종료된 작업입니다' });
    }
    const result = brokerSyncService.cancelSync(jobId);
    if (result === 'NOT_RUNNING') {
      // RUNNING 으로 남았지만 이 프로세스에 없다 — 재시작 고아. 부팅 정리와 같은 처리.
      return reply.code(409).send({
        error: '이 프로세스에서 실행 중인 작업이 아닙니다 — 서버 재시작으로 중단된 작업이면 자동 정리됩니다',
      });
    }
    return reply.code(202).send({ status: 'CANCELLING' });
  });
}
