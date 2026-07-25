import { isValidCandle, type Candle, type Market, type Timeframe } from '../domain/candle.js';

export interface CsvParseResult {
  readonly candles: Candle[];
  readonly errors: string[];
}

const REQUIRED_COLUMNS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;

/**
 * OHLCV CSV 파서. 요구 포맷:
 *   header: timestamp,open,high,low,close,volume
 *   timestamp: ISO 8601(UTC 권장) 또는 epoch milliseconds
 * 따옴표·쉼표 포함 필드는 지원하지 않는다 (수치 데이터 전용).
 */
export function parseCandleCsv(
  content: string,
  meta: { market: Market; timeframe: Timeframe; symbol: string },
): CsvParseResult {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { candles: [], errors: ['CSV 에 데이터 행이 없습니다'] };
  }

  const header = (lines[0] as string).split(',').map((cell) => cell.trim().toLowerCase());
  const columnIndex = new Map<string, number>();
  header.forEach((name, idx) => columnIndex.set(name, idx));

  for (const column of REQUIRED_COLUMNS) {
    if (!columnIndex.has(column)) {
      return { candles: [], errors: [`필수 컬럼 누락: ${column}`] };
    }
  }

  const candles: Candle[] = [];
  const errors: string[] = [];

  for (let lineNo = 1; lineNo < lines.length; lineNo += 1) {
    const cells = (lines[lineNo] as string).split(',').map((cell) => cell.trim());
    const cell = (name: string): string => cells[columnIndex.get(name) as number] ?? '';

    const rawTs = cell('timestamp');
    const tsMs = /^\d+$/.test(rawTs) ? Number(rawTs) : Date.parse(rawTs);
    if (!Number.isFinite(tsMs)) {
      errors.push(`${lineNo + 1}행: timestamp 해석 불가 (${rawTs})`);
      continue;
    }

    const candle: Candle = {
      symbol: meta.symbol,
      market: meta.market,
      timeframe: meta.timeframe,
      tsMs,
      open: Number(cell('open')),
      high: Number(cell('high')),
      low: Number(cell('low')),
      close: Number(cell('close')),
      volume: Number(cell('volume')),
    };

    if (!isValidCandle(candle)) {
      errors.push(`${lineNo + 1}행: OHLCV 값이 유효하지 않습니다`);
      continue;
    }
    candles.push(candle);
  }

  return { candles, errors };
}
