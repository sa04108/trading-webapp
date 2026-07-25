import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DatasetService } from '../application/dataset-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const importFieldsSchema = z.object({
  datasetName: z.string().min(1).max(64),
  market: z.enum(['KR', 'US']),
  timeframe: z.enum(['1m', '1h']),
  symbol: z.string().regex(/^[A-Za-z0-9._-]{1,20}$/),
});

const MAX_CSV_BYTES = 50 * 1024 * 1024;

export function registerDatasetRoutes(
  app: FastifyInstance,
  datasetService: DatasetService,
  requireAuth: PreHandler,
): void {
  app.get('/datasets', { preHandler: requireAuth }, async () => ({
    datasets: datasetService.listDatasets(),
  }));

  app.get('/datasets/:datasetId', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: 'Dataset not found' });
    return dataset;
  });

  app.get('/datasets/:datasetId/coverage', { preHandler: requireAuth }, async (request, reply) => {
    const { datasetId } = request.params as { datasetId: string };
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return reply.code(404).send({ error: 'Dataset not found' });
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
    // 실제 포맷 검증 (스펙 §16): 헤더 시그니처 확인
    const firstLine = csvContent.slice(0, 200).split(/\r?\n/)[0]?.toLowerCase() ?? '';
    if (!firstLine.includes('timestamp') || !firstLine.includes('open')) {
      return reply.code(400).send({ error: 'CSV 헤더가 올바르지 않습니다 (timestamp,open,high,low,close,volume)' });
    }

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

  app.post('/datasets/sync', { preHandler: requireAuth }, async (_request, reply) =>
    reply.code(501).send({
      error: '증권사 데이터 동기화는 API 자격 증명 설정 후 제공됩니다. CSV import 를 사용하세요.',
    }),
  );

  app.get('/data-jobs/:jobId', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = datasetService.getImportJob(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return { job };
  });
}
