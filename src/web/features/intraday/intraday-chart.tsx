import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  TickMarkType,
  type CandlestickData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api } from "@/lib/api-client";
import type {
  IntradayBar,
  IntradayChart,
  IntradayChartTimeframe,
  IntradayFill,
  IntradaySignal,
} from "../../../shared/schemas/intraday";

interface IntradayChartViewProps {
  symbol: string;
  from: string;
  to: string;
  timeframe: IntradayChartTimeframe;
  showSummary?: boolean;
  expectedRevision?: string;
  signals?: IntradaySignal[];
  fills?: IntradayFill[];
}

const kstDateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const kstTick = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const kstDay = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" });
const kstMonth = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" });
const kstYear = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric" });
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const formatTime = (ms: number) => kstDateTime.format(ms);
const timestamp = (ms: number) => (ms / 1000) as UTCTimestamp;
const seconds = (time: Time) => (typeof time === "number" ? time : 0);

function periodKey(ms: number, timeframe: IntradayChartTimeframe): string {
  const date = new Date(ms + 9 * 3_600_000);
  if (timeframe === "1mo") return date.toISOString().slice(0, 7);
  if (timeframe === "1w") {
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  }
  return date.toISOString().slice(0, 10);
}

function markersForBars(
  bars: IntradayBar[],
  timeframe: IntradayChartTimeframe,
  signals: IntradaySignal[],
  fills: IntradayFill[],
): SeriesMarker<Time>[] {
  const calendar = timeframe === "1d" || timeframe === "1w" || timeframe === "1mo";
  const calendarBars = new Map<string, IntradayBar>();
  if (calendar) {
    for (const bar of bars) calendarBars.set(periodKey(bar.endMs, timeframe), bar);
  }
  const findBar = (ms: number, fill: boolean): IntradayBar | undefined => {
    if (calendar) return calendarBars.get(periodKey(ms, timeframe));
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bars[mid]!.endMs < ms || (fill && bars[mid]!.endMs === ms)) lo = mid + 1;
      else hi = mid;
    }
    const bar = bars[lo];
    const duration = Number.parseInt(timeframe, 10) * (timeframe === "1h" ? 3_600_000 : 60_000);
    return bar && (fill ? ms >= bar.endMs - duration : ms > bar.endMs - duration) ? bar : undefined;
  };
  const markers: SeriesMarker<Time>[] = [];
  for (const signal of signals) {
    const bar = findBar(signal.atMs, false);
    if (bar) markers.push({ time: timestamp(bar.endMs), position: "aboveBar", color: "#a855f7", shape: "arrowDown", text: `신호 ${signal.side}` });
  }
  for (const fill of fills) {
    const bar = findBar(fill.atMs, true);
    if (bar) markers.push({ time: timestamp(bar.endMs), position: "belowBar", color: "#16a34a", shape: "circle", text: `체결 ${fill.side}` });
  }
  return markers.sort((a, b) => seconds(a.time) - seconds(b.time));
}

export function IntradayChartView({
  symbol,
  from,
  to,
  timeframe,
  showSummary = false,
  expectedRevision,
  signals,
  fills,
}: IntradayChartViewProps) {
  const { resolvedTheme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ bar: IntradayBar; x: number; y: number } | null>(null);
  const valid = /^\d{6}$/.test(symbol) && !!from && !!to && from <= to;
  const query = useQuery({
    queryKey: ["intraday-chart", symbol, from, to, timeframe],
    queryFn: () => api<IntradayChart>(`/intraday/chart?${new URLSearchParams({ symbol, from, to, timeframe })}`),
    enabled: valid,
    // 수집 현황과 독립된 화면 스냅샷을 유지하고 조회 조건을 바꿀 때 최신 데이터를 받는다.
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    placeholderData: keepPreviousData,
  });
  const bars = query.data?.bars;
  const chartTimeframe = query.data?.timeframe ?? timeframe;
  const barByTime = useMemo(() => new Map((bars ?? []).map((bar) => [bar.endMs / 1000, bar])), [bars]);
  const showMarkers = !!expectedRevision && query.data?.revision === expectedRevision;
  const dark = resolvedTheme === "dark";
  const markers = useMemo(
    () => showMarkers && bars ? markersForBars(bars, chartTimeframe, signals ?? [], fills ?? []) : [],
    [showMarkers, bars, chartTimeframe, signals, fills],
  );

  useEffect(() => {
    const element = container.current;
    if (!element || !bars?.length) return;
    const background = dark ? "#0a0a0a" : "#ffffff";
    const foreground = dark ? "#a3a3a3" : "#737373";
    const grid = dark ? "#262626" : "#f1f1f1";
    const chart = createChart(element, {
      width: element.clientWidth,
      height: 480,
      layout: { background: { type: ColorType.Solid, color: background }, textColor: foreground, attributionLogo: true },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time, type: TickMarkType) => {
        const ms = seconds(t) * 1000;
        if (type === TickMarkType.Year) return kstYear.format(ms);
        if (type === TickMarkType.Month || chartTimeframe === "1mo") return kstMonth.format(ms);
        if (type === TickMarkType.DayOfMonth || chartTimeframe === "1d" || chartTimeframe === "1w") return kstDay.format(ms);
        return kstTick.format(ms);
      } },
      localization: { timeFormatter: (t: Time) => formatTime(seconds(t) * 1000), locale: "ko-KR" },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#ef4444", downColor: "#3b82f6", borderUpColor: "#ef4444", borderDownColor: "#3b82f6", wickUpColor: "#ef4444", wickDownColor: "#3b82f6",
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    chart.panes()[0]?.setStretchFactor(4);
    chart.panes()[1]?.setStretchFactor(1);
    candles.setData(bars.map((bar) => ({ time: timestamp(bar.endMs), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    volume.setData(bars.map((bar) => ({ time: timestamp(bar.endMs), value: bar.volume, color: bar.close >= bar.open ? "#ef444499" : "#3b82f699" })));
    const markerSeries = createSeriesMarkers(candles, markers);
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 100), to: bars.length + 3 });
    setHovered(null);
    const onCrosshair = (param: Parameters<Parameters<typeof chart.subscribeCrosshairMove>[0]>[0]) => {
      const data = param.seriesData.get(candles) as CandlestickData<Time> | undefined;
      const bar = data && typeof data.time === "number" ? barByTime.get(data.time) : undefined;
      setHovered(bar && param.point ? {
        bar,
        x: Math.max(0, Math.min(element.clientWidth - 190, param.point.x + 14)),
        y: Math.max(32, Math.min(480 - 170, param.point.y + 14)),
      } : null);
    };
    chart.subscribeCrosshairMove(onCrosshair);
    const observer = new ResizeObserver(() => chart.applyOptions({ width: element.clientWidth }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      markerSeries.detach();
      chart.remove();
    };
  }, [dark, bars, barByTime, markers, chartTimeframe]);

  const displayed = hovered?.bar ?? bars?.[bars.length - 1];
  return (
    <div className="space-y-2">
      {showSummary && bars && bars.length > 0 && (() => {
        const first = bars[0]!;
        const last = bars[bars.length - 1]!;
        const change = last.close - first.open;
        const percentage = (change / first.open) * 100;
        return <div className="flex flex-wrap items-baseline gap-x-3"><strong className="text-2xl">{number.format(last.close)}원</strong><span className={change > 0 ? "text-sm text-red-500" : change < 0 ? "text-sm text-blue-500" : "text-sm text-muted-foreground"}>{change > 0 ? "+" : ""}{number.format(change)}원 ({change > 0 ? "+" : ""}{percentage.toFixed(2)}%)</span><span className="text-xs text-muted-foreground">조회 기간 첫 봉 시가 대비 · 마지막 봉 종가</span></div>;
      })()}
      {query.error && <Alert variant="destructive"><AlertDescription>{query.error instanceof Error ? query.error.message : "차트를 불러오지 못했습니다."}</AlertDescription></Alert>}
      <p role="status" aria-label="차트 조회 상태" className="h-5 text-sm text-muted-foreground">{query.isFetching ? "차트 불러오는 중…" : ""}</p>
      {expectedRevision && query.data && !showMarkers && <Alert><AlertDescription>수집 데이터가 갱신되어 실행 당시 차트와 다를 수 있습니다.</AlertDescription></Alert>}
      {query.data?.truncated && <Alert><AlertDescription>표시 가능한 봉 수를 초과했습니다. 날짜 범위를 좁혀 주세요.</AlertDescription></Alert>}
      {query.data && <div className="text-sm text-muted-foreground">
        <p>{number.format(query.data.totalBars)}개 봉 · 누락 구간 {number.format(query.data.gaps.length)}개</p>
        {query.data.gaps.length > 0 && <details><summary className="cursor-pointer">누락 구간 보기</summary><ul className="mt-1 space-y-1">{query.data.gaps.slice(0, 20).map((gap) => <li key={`${gap.fromMs}-${gap.toMs}`}>{formatTime(gap.fromMs)} ~ {formatTime(gap.toMs)} ({gap.missingMinutes}분)</li>)}</ul>{query.data.gaps.length > 20 && <p>외 {number.format(query.data.gaps.length - 20)}개 구간</p>}</details>}
      </div>}
      {query.data && query.data.gaps.length > 0 && <Alert><AlertDescription>분봉이 누락된 구간이 있습니다. 백테스트는 경고와 함께 계속되며, 누락 구간에서는 매매를 시뮬레이션하지 않습니다.</AlertDescription></Alert>}
      {markers.length > 0 && <ul className="sr-only" aria-label="차트 신호 및 체결">{markers.slice(0, 100).map((marker, index) => <li key={index}>{marker.text} · {formatTime(seconds(marker.time) * 1000)} KST</li>)}</ul>}
      {showMarkers && <p className="text-sm text-muted-foreground">▼ 보라색: 신호 · ● 초록색: 체결 (한국 시각)</p>}
      {bars && bars.length > 0 ? (
        <div className="overflow-hidden rounded border bg-background">
          <div className="flex flex-wrap gap-x-3 px-3 py-2 text-xs text-muted-foreground" aria-live="off">
            {displayed && <><span>{formatTime(displayed.endMs)} KST</span><span>시 {number.format(displayed.open)}</span><span>고 {number.format(displayed.high)}</span><span>저 {number.format(displayed.low)}</span><span>종 {number.format(displayed.close)}</span><span>거래량 {number.format(displayed.volume)}</span></>}
          </div>
          <div className="relative">
          {hovered && <div role="tooltip" className="pointer-events-none absolute z-20 w-44 rounded border bg-popover/95 p-2 text-xs shadow-md" style={{ left: hovered.x, top: hovered.y }}>
            <p className="mb-1 font-medium">{formatTime(hovered.bar.endMs)} KST</p>
            <p>시가 {number.format(hovered.bar.open)}</p><p>고가 {number.format(hovered.bar.high)}</p><p>저가 {number.format(hovered.bar.low)}</p><p>종가 {number.format(hovered.bar.close)}</p><p>거래량 {number.format(hovered.bar.volume)}</p>
          </div>}
          <div ref={container} role="img" aria-label="가격 캔들 및 거래량 차트. 드래그하여 이동하고 스크롤하여 확대하거나 축소할 수 있습니다." />
          </div>
        </div>
      ) : query.data ? <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p> : !valid ? <p className="text-sm text-muted-foreground">종목 코드와 날짜를 입력하세요.</p> : null}
      <p className="text-right text-xs text-muted-foreground">TradingView Lightweight Charts™ · Copyright © 2025 <a className="underline" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView, Inc.</a></p>
    </div>
  );
}
