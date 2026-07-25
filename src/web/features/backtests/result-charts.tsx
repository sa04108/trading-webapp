import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatKrw, formatSignedPct } from './format';
import type { SeriesPoint } from './types';

const GAIN = 'var(--gain)';
const LOSS = 'var(--loss)';
const GRID = 'var(--border)';
const INK = 'var(--muted-foreground)';
const AXIS_TICK = { fontSize: 11, fill: INK } as const;

function compactKrw(value: number): string {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(1)}억`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(0)}만`;
  return String(Math.round(value));
}

const tooltipContentStyle = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
} as const;

/** 자산 곡선 — 단일 시리즈 라인 (범례 불필요, 제목이 시리즈를 명명) */
export function EquityChart({ points, summary }: { points: SeriesPoint[]; summary: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">자산 곡선</CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-60 w-full" role="img" aria-label={`자산 곡선 차트. ${summary}`}>
          <ResponsiveContainer>
            <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="tsMs"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(ts: number) => formatDate(ts).slice(2)}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={48}
              />
              <YAxis
                tickFormatter={compactKrw}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={52}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={tooltipContentStyle}
                labelFormatter={(ts) => formatDate(Number(ts))}
                formatter={(value) => [formatKrw(Number(value)), '평가금액']}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Drawdown — 손실 극성이므로 loss 색 단일 영역 */
export function DrawdownChart({ points, summary }: { points: SeriesPoint[]; summary: string }) {
  const percentPoints = points.map((p) => ({ tsMs: p.tsMs, value: p.value * 100 }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Drawdown</CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-52 w-full" role="img" aria-label={`낙폭 차트. ${summary}`}>
          <ResponsiveContainer>
            <AreaChart data={percentPoints} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="tsMs"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(ts: number) => formatDate(ts).slice(2)}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={48}
              />
              <YAxis
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={tooltipContentStyle}
                labelFormatter={(ts) => formatDate(Number(ts))}
                formatter={(value) => [`${Number(value).toFixed(2)}%`, '낙폭']}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={LOSS}
                strokeWidth={2}
                fill={LOSS}
                fillOpacity={0.15}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** 월별 수익률 — 극성(+/-) bar. 색 + 부호 텍스트 병행 (스펙 §17) */
export function MonthlyReturnsChart({
  monthly,
}: {
  monthly: Array<{ year: number; month: number; returnPct: number }>;
}) {
  const data = monthly.map((m) => ({
    label: `${String(m.year).slice(2)}.${String(m.month).padStart(2, '0')}`,
    returnPct: m.returnPct,
  }));
  const best = monthly.reduce((a, b) => (b.returnPct > a ? b.returnPct : a), -Infinity);
  const worst = monthly.reduce((a, b) => (b.returnPct < a ? b.returnPct : a), Infinity);
  const summary =
    monthly.length > 0
      ? `최고 ${formatSignedPct(best)} · 최저 ${formatSignedPct(worst)} (빨강 +수익 / 파랑 -손실)`
      : '데이터 없음';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">월별 수익률</CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-52 w-full" role="img" aria-label={`월별 수익률 차트. ${summary}`}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 4 }} barCategoryGap="25%">
              <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                contentStyle={tooltipContentStyle}
                formatter={(value) => [formatSignedPct(Number(value)), '수익률']}
                cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
              />
              <Bar dataKey="returnPct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {data.map((entry) => (
                  <Cell key={entry.label} fill={entry.returnPct >= 0 ? GAIN : LOSS} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
