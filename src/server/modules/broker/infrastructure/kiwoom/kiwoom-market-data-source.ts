import type { Logger } from '../../../../shared/logger.js';
import type {
  FetchCandleRequest,
  FetchCandleResult,
  MarketDataSource,
} from '../../../market-data/application/ports.js';
import { BrokerRestClient, type TokenProvider } from '../rest-client.js';

export class BrokerNotConfiguredError extends Error {
  constructor() {
    super('증권사 API 자격 증명이 설정되지 않았습니다. CSV/Parquet import 를 사용하세요.');
    this.name = 'BrokerNotConfiguredError';
  }
}

export interface KiwoomConfig {
  readonly baseUrl: string; // 예: https://api.kiwoom.com (모의투자: https://mockapi.kiwoom.com)
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * 키움 REST API 어댑터 (1차 증권사 어댑터, docs/DECISIONS.md D-002).
 *
 * App Key 발급 전까지는 비활성 상태이며 fetchCandles 가 BrokerNotConfiguredError 를 던진다.
 * 엔드포인트 경로·TR 코드는 자격 증명 발급 후 openapi.kiwoom.com 문서 기준으로
 * 검증해 config 로 조정한다. 공통 REST 클라이언트(토큰·rate limit·backoff)는 재사용된다.
 */
export function createKiwoomMarketDataSource(
  config: KiwoomConfig | null,
  logger: Logger,
): MarketDataSource {
  if (!config) {
    return {
      fetchCandles(): Promise<FetchCandleResult> {
        return Promise.reject(new BrokerNotConfiguredError());
      },
    };
  }

  const tokenProvider: TokenProvider = {
    async issueToken(fetchImpl) {
      const response = await fetchImpl(`${config.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: config.appKey,
          secretkey: config.appSecret,
        }),
      });
      if (!response.ok) {
        throw new Error(`kiwoom token issue failed: ${response.status}`);
      }
      const body = (await response.json()) as { token: string };
      return {
        accessToken: body.token,
        // 응답의 expires_dt 는 아직 파싱하지 않는다 (자격 증명 발급 후 형식 검증 예정) —
        // 그때까지는 12시간 보수 캐싱으로 고정
        expiresAtMs: Date.now() + 12 * 3600 * 1000,
      };
    },
  };

  const client = new BrokerRestClient({
    baseUrl: config.baseUrl,
    tokenProvider,
    logger,
    groupMinIntervalMs: { chart: 350, default: 350 },
  });

  return {
    async fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult> {
      // TR ka10080(분봉)/ka10081(일봉) 응답 매핑은 자격 증명 발급 후 검증 예정.
      // 검증 전 호출은 명시적으로 실패시켜 조용한 오데이터 유입을 막는다.
      void client;
      void request;
      throw new BrokerNotConfiguredError();
    },
  };
}
