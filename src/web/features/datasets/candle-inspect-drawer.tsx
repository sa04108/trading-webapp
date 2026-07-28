import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api-client';

const GAIN = 'var(--gain)'; // KR 관례: 상승 빨강
const LOSS = 'var(--loss)'; // 하락 파랑
const GRID = 'var(--border)';
const INK = 'var(--muted-foreground)';

interface CandleRow {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandlesResponse {
  candles: CandleRow[];
  missingRanges: Array<{ fromTsMs: number; toTsMs: number }>;
}

/** timeframe 별 기간 프리셋 — 상한 2,000봉 안에 들어오는 구성만 노출한다 */
const PRESETS: Record<string, Array<{ label: string; ms: number }>> = {
  '1m': [
    { label: '최근 1일', ms: 86_400_000 },
    { label: '최근 1주', ms: 7 * 86_400_000 },
  ],
  '1h': [
    { label: '최근 1달', ms: 30 * 86_400_000 },
    { label: '최근 1년', ms: 365 * 86_400_000 },
  ],
  '1d': [
    { label: '최근 1년', ms: 365 * 86_400_000 },
    { label: '최근 5년', ms: 5 * 365 * 86_400_000 },
  ],
};

function formatTs(tsMs: number, timeframe: string): string {
  const date = new Date(tsMs);
  if (timeframe === '1d') {
    return date.toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: CandleRow;
}

/** 심지 1px + 몸통 — dataKey 가 [low, high] 라 y/height 가 봉 전체 범위에 대응한다 */
function CandleShape({ x = 0, y = 0, width = 0, height = 0, payload }: CandleShapeProps) {
  if (!payload || height <= 0) return <g />;
  const { open, close, high, low } = payload;
  const px = (value: number) =>
    high === low ? y : y + ((high - value) / (high - low)) * height;
  const up = close >= open;
  const color = up ? GAIN : LOSS;
  const cx = x + width / 2;
  const bodyTop = px(Math.max(open, close));
  const bodyWidth = Math.max(1, Math.min(width * 0.8, 9));
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect
        x={cx - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={Math.max(1, px(Math.min(open, close)) - bodyTop)}
        fill={color}
        rx={1}
      />
    </g>
  );
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
  padding: '6px 10px',
};

function CandleTooltip({
  active,
  payload,
  timeframe,
}: {
  active?: boolean;
  payload?: Array<{ payload: CandleRow }>;
  timeframe: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div style={tooltipStyle}>
      <div className="font-medium">{formatTs(row.tsMs, timeframe)}</div>
      <div>
        시 {row.open.toLocaleString()} · 고 {row.high.toLocaleString()} · 저{' '}
        {row.low.toLocaleString()} · 종 {row.close.toLocaleString()}
      </div>
      <div className="text-muted-foreground">거래량 {row.volume.toLocaleString()}</div>
    </div>
  );
}

export function CandleInspectDrawer({
  datasetId,
  datasetTimeframe,
  symbol,
  symbolName,
  anchorTsMs,
  open,
  onOpenChange,
}: {
  datasetId: string;
  /** 데이터셋 소비 timeframe (1h | 1d) — 조회 가능한 timeframe 을 결정 */
  datasetTimeframe: string;
  symbol: string;
  symbolName: string | null;
  /** 조회 구간의 끝점 — coverage 의 마지막 봉 (없으면 현재 시각) */
  anchorTsMs: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const timeframes = datasetTimeframe === '1h' ? ['1h', '1m'] : [datasetTimeframe];
  const [timeframe, setTimeframe] = useState(timeframes[0] ?? '1d');
  const [presetIndex, setPresetIndex] = useState(0);

  const presets = PRESETS[timeframe] ?? PRESETS['1d']!;
  const preset = presets[Math.min(presetIndex, presets.length - 1)]!;
  const toTsMs = anchorTsMs ?? Date.now();
  const fromTsMs = toTsMs - preset.ms;

  const { data, error, isLoading } = useQuery({
    queryKey: ['inspect-candles', datasetId, symbol, timeframe, fromTsMs, toTsMs],
    queryFn: () =>
      api<CandlesResponse>(
        `/datasets/${datasetId}/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&fromTsMs=${fromTsMs}&toTsMs=${toTsMs}`,
      ),
    enabled: open,
    staleTime: 60_000,
  });

  const candles = data?.candles ?? [];
  const range: [number, number] = [fromTsMs, toTsMs];
  const barSize = candles.length <= 100 ? 6 : candles.length <= 500 ? 3 : 1;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>
            {symbol}
            {symbolName ? ` ${symbolName}` : ''} — 데이터 검증
          </DrawerTitle>
          <DrawerDescription>
            상승 빨강 · 하락 파랑. 빈 공간은 봉이 없는 구간입니다
            {timeframe === datasetTimeframe ? ' (회색 음영: coverage 누락 구간)' : ''}.
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-3 p-4 pb-8">
          <div className="flex flex-wrap gap-2">
            {timeframes.length > 1 ? (
              <Select
                value={timeframe}
                onValueChange={(value) => {
                  setTimeframe(value);
                  setPresetIndex(0);
                }}
              >
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timeframes.map((tf) => (
                    <SelectItem key={tf} value={tf}>
                      {tf === '1m' ? '1분봉 (원본)' : tf === '1h' ? '1시간봉' : '일봉'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={String(presetIndex)} onValueChange={(v) => setPresetIndex(Number(v))}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p, index) => (
                  <SelectItem key={p.label} value={String(index)}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {error instanceof ApiError ? error.message : '조회 실패'}
            </p>
          ) : candles.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              이 구간에 데이터가 없습니다 — 동기화 또는 CSV 가져오기가 필요합니다.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={candles} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="tsMs"
                    type="number"
                    domain={range}
                    tickFormatter={(ts: number) => formatTs(ts, timeframe)}
                    tick={{ fill: INK, fontSize: 11 }}
                    minTickGap={56}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={{ fill: INK, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v: number) => v.toLocaleString()}
                  />
                  <Tooltip
                    content={<CandleTooltip timeframe={timeframe} />}
                    isAnimationActive={false}
                  />
                  {timeframe === datasetTimeframe
                    ? (data?.missingRanges ?? []).map((missing) => (
                        <ReferenceArea
                          key={`${missing.fromTsMs}`}
                          x1={Math.max(missing.fromTsMs, fromTsMs)}
                          x2={Math.min(missing.toTsMs, toTsMs)}
                          fill={INK}
                          fillOpacity={0.08}
                          strokeOpacity={0}
                        />
                      ))
                    : null}
                  <Bar
                    dataKey={(row: CandleRow) => [row.low, row.high]}
                    shape={<CandleShape />}
                    barSize={barSize}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <ResponsiveContainer width="100%" height={72}>
                <ComposedChart data={candles} margin={{ top: 0, right: 8, bottom: 0, left: 4 }}>
                  <XAxis dataKey="tsMs" type="number" domain={range} hide />
                  <YAxis
                    tick={{ fill: INK, fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    tickFormatter={(v: number) =>
                      v >= 1_000_000 ? `${Math.round(v / 1_000_000)}M` : v.toLocaleString()
                    }
                  />
                  <Bar dataKey="volume" barSize={barSize} isAnimationActive={false} fill={INK} fillOpacity={0.45} />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-xs text-muted-foreground">
                {candles.length.toLocaleString()}봉 · {formatTs(fromTsMs, '1d')} ~{' '}
                {formatTs(toTsMs, '1d')}
              </p>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
