import type { Logger } from "../../../../shared/logger.js";
import {
  StockInfoSourceNotConfiguredError,
  type StockInfo,
  type StockInfoBatchResult,
  type StockInfoSource,
} from "../../../../../runtime/modules/market-data/application/ports.js";
import { createTossClient, type TossClient, type TossClientOptions } from "./toss-client.js";

export interface TossConfig {
  readonly baseUrl: string; // https://openapi.tossinvest.com — 실전 환경만 제공 (모의 없음)
  readonly clientId: string;
  readonly clientSecret: string;
}

/** 다건 조회의 심볼 상한 — /stocks 는 콤마 구분 200건이다 */
const LOOKUP_CHUNK = 200;

/**
 * 숫자 문자열을 읽되 **깨진 값은 던지지 않고 null 로 접는다**. 발행주식수는 표시와
 * 정렬에만 쓰이므로, 한 종목의 이상한 값 때문에 200종목 응답 전체를 버릴 이유가 없다.
 */
function optionalDecimal(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface TossSourceOptions extends TossClientOptions {
  readonly client?: TossClient;
}

/**
 * 토스증권 Open API 어댑터 — 종목 이름 조회 전용 (스펙 §13).
 *
 * - 인증: POST /oauth2/token — OAuth2 client_credentials, form-urlencoded (키움과 달리 JSON 아님).
 *   재발급 시 이전 토큰이 즉시 무효화되므로 프로세스당 클라이언트 1개로 캐싱을 공유한다.
 * - 종목 정보: GET /api/v1/stocks — 종목 이름 검색과 표시 정보를 제공한다.
 * - Rate limit: STOCK 그룹 초당 5회.
 */
export function createTossStockInfoSource(
  config: TossConfig | null,
  logger: Logger,
  options: TossSourceOptions = {},
): StockInfoSource {
  if (!config) {
    return {
      getStockInfo(): Promise<StockInfoBatchResult> {
        return Promise.reject(new StockInfoSourceNotConfiguredError());
      },
    };
  }

  const client = options.client ?? createTossClient(config, logger, options);

  return {
    async getStockInfo(
      symbols: readonly string[],
    ): Promise<StockInfoBatchResult> {
      const stocks: StockInfo[] = [];
      const failedSymbols: string[] = [];
      // GET /api/v1/stocks 는 콤마 구분 최대 200건
      for (let offset = 0; offset < symbols.length; offset += LOOKUP_CHUNK) {
        const chunk = symbols.slice(offset, offset + LOOKUP_CHUNK);
        try {
          const query = new URLSearchParams({ symbols: chunk.join(",") });
          const page = await client.request<{
            result?: readonly Record<string, unknown>[];
          }>(`/api/v1/stocks?${query}`);
          if (!Array.isArray(page.result)) {
            throw new Error("toss stocks 응답에 result 배열이 없습니다");
          }
          // 청크 전체가 검증을 통과한 뒤에만 stocks 에 합친다 — 페이지 뒷부분에서
          // throw 하면, 이미 파싱한 앞부분만 살아남아 이 청크가 "일부 성공"이 되는
          // 것을 막는다. 청크는 성공 아니면 실패, 둘 중 하나다.
          const chunkStocks: StockInfo[] = [];
          for (const raw of page.result) {
            if (
              typeof raw.symbol !== "string" ||
              typeof raw.name !== "string"
            ) {
              throw new Error(
                "toss stocks 응답 항목에 symbol/name 이 없습니다",
              );
            }
            chunkStocks.push({
              symbol: raw.symbol,
              name: raw.name,
              englishName:
                typeof raw.englishName === "string" ? raw.englishName : null,
              market: typeof raw.market === "string" ? raw.market : "",
              status: typeof raw.status === "string" ? raw.status : "",
              sharesOutstanding: optionalDecimal(raw.sharesOutstanding),
            });
          }
          stocks.push(...chunkStocks);
        } catch (error) {
          // 청크(최대 200건) 하나의 실패가 다른 청크의 정상 종목까지 지우면 안 된다 —
          // 상장폐지 코드 하나가 섞여 이 청크 전체가 404 나도, 같은 요청에 포함된
          // 나머지 청크는 그대로 살려야 한다. 청크 안에서 종목별로 쪼개 재시도하지는
          // 않는다(호출량 폭발) — 대신 이 청크에 속한 코드를 failedSymbols 로 표시해
          // 호출부(SymbolInfoService)가 "모른다" 로 부정 캐시하지 않고 다음 조회에서
          // 다시 묻게 한다. 그 사이 이름은 로컬 종목 마스터 폴백이 메운다.
          failedSymbols.push(...chunk);
          logger.warn(
            {
              module: "market-data",
              event: "toss.get-stock-info.chunk-failed",
              symbols: chunk,
              err: error,
            },
            "toss stock info chunk lookup failed — skipping this chunk",
          );
        }
      }
      return { stocks, failedSymbols };
    },
  };
}
