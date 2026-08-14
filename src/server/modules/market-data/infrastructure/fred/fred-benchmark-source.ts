import { z } from 'zod';
import type { FredBenchmarkId } from '../../../../../shared/schemas/benchmark.js';
import { RestClient } from '../../../../shared/rest-client.js';
import type { Logger } from '../../../../shared/logger.js';
import {
  FredContractError,
  FredNotConfiguredError,
  type FredBenchmarkSource,
} from '../../application/ports.js';

export interface FredConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

const responseSchema = z.object({
  observations: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    value: z.string(),
  })),
});

export function createFredBenchmarkSource(
  config: FredConfig | null,
  logger: Logger,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): FredBenchmarkSource {
  if (config === null) {
    return {
      fetchBenchmarkRange: async () => { throw new FredNotConfiguredError(); },
    };
  }

  const client = new RestClient({
    baseUrl: config.baseUrl,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  return {
    fetchBenchmarkRange: async (benchmarkId: FredBenchmarkId, from: string, to: string) => {
      const query = new URLSearchParams({
        series_id: benchmarkId,
        observation_start: from,
        observation_end: to,
        file_type: 'json',
        api_key: config.apiKey,
      });
      let payload: unknown;
      try {
        payload = await client.request('default', `/fred/series/observations?${query}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'FRED API 요청에 실패했습니다.';
        throw new Error(message.replaceAll(config.apiKey, '[REDACTED]'));
      }

      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) throw new FredContractError();

      const points = parsed.data.observations.flatMap(({ date, value }) => {
        if (value === '.') return [];
        const close = Number(value);
        if (date < from || date > to || !Number.isFinite(close) || close <= 0) {
          throw new FredContractError();
        }
        return [{ date, close }];
      });
      logger.info(
        { module: 'market-data', event: 'fred.fetch', benchmarkId, from, to, rows: points.length },
        'fred fetch ok',
      );
      return points;
    },
  };
}
