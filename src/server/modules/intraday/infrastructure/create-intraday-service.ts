import path from "node:path";
import { z } from "zod";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { TossClient } from "../../broker/infrastructure/toss/toss-client.js";
import type { SymbolInfoService } from "../../market-data/application/symbol-info-service.js";
import { createOfficialKrxTradingCalendar } from "../../market-data/infrastructure/krx/krx-trading-calendar.js";
import {
  IntradayError,
  IntradayService,
} from "../application/intraday-service.js";
import { executeIntraday } from "../application/forked-intraday-engine.js";
import { ParquetIntradayStore } from "./parquet-intraday-store.js";
import { TossIntradaySource } from "./toss-intraday-source.js";

const instrumentSchema = z.object({
  symbol: z.string(),
  market: z.enum(["KOSPI", "KOSDAQ"]),
  securityType: z.literal("STOCK"),
  isCommonShare: z.literal(true),
  isinCode: z.string().min(1),
  listDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function createIntradayService(options: {
  database: DatabaseHandle;
  dataRoot: string;
  client?: TossClient;
  symbolInfo: SymbolInfoService;
}): IntradayService {
  const instrumentCache = new Map<
    string,
    { expires: number; value: { listDate: string; isinCode: string } }
  >();
  return new IntradayService({
    db: options.database.db,
    store: new ParquetIntradayStore(path.join(options.dataRoot, "intraday")),
    source: options.client ? new TossIntradaySource(options.client) : null,
    calendar: createOfficialKrxTradingCalendar(),
    execute: executeIntraday,
    validateSymbol: async (symbol) => {
      const cached = instrumentCache.get(symbol);
      if (cached && cached.expires > Date.now()) return cached.value;
      if (!options.client)
        throw new IntradayError("서버의 토스증권 API 연결 설정을 확인하세요.");
      const data = await options.client.request<{ result?: unknown[] }>(
        "stock",
        `/api/v1/stocks?${new URLSearchParams({ symbols: symbol })}`,
      );
      const parsed = instrumentSchema.safeParse(
        data.result?.find(
          (r) =>
            typeof r === "object" &&
            r !== null &&
            "symbol" in r &&
            r.symbol === symbol,
        ),
      );
      if (!parsed.success)
        throw new IntradayError(
          "초기 분봉 백테스트는 토스에서 종목 식별·상장일을 확인할 수 있는 KOSPI·KOSDAQ 보통주만 지원합니다.",
        );
      const value = {
        listDate: parsed.data.listDate,
        isinCode: parsed.data.isinCode,
      };
      instrumentCache.set(symbol, { value, expires: Date.now() + 3_600_000 });
      return value;
    },
    search: async (query) => {
      if (/^\d{6}$/.test(query)) {
        const result = await options.symbolInfo.lookup([query]);
        return [{ symbol: query, name: result[0]?.name ?? query }];
      }
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      const rows = options.database.sqlite
        .prepare(
          "SELECT code AS symbol, COALESCE(name, code) AS name FROM data.symbols WHERE length(code) = 6 AND (name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\') ORDER BY code LIMIT 20",
        )
        .all(`%${escaped}%`, `${escaped}%`) as {
        symbol: string;
        name: string;
      }[];
      return rows.filter((r) => /^\d{6}$/.test(r.symbol));
    },
  });
}
