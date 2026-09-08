import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { lowPerHighRoeRankStrategy } from '../../src/server/modules/strategy/strategies/low-per-high-roe-rank.js';
import { valuationSnapshot, type ValuationObservation } from './quarterly-value.js';
import { quarterWindows, STAGES, type ResearchInput } from './quarter-engine.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('사용법: valuation-coverage.ts input.gz output.json');
const input = JSON.parse(gunzipSync(readFileSync(inputPath)).toString()) as ResearchInput;
const rows = new Map<string, ValuationObservation[]>();
for (const observation of input.valuationObservations ?? []) {
  const list = rows.get(observation.symbol) ?? [];
  list.push(observation);
  rows.set(observation.symbol, list);
}
const caps = new Map((input.capitalizations ?? []).map((p) => [p.tsMs, p.values]));
const p = lowPerHighRoeRankStrategy.parameterSchema.parse({ topN: 5 });
const stages = Object.entries(STAGES).map(([stage, [from, to]]) => {
  const windows = quarterWindows(input.days, from, input.asof < to ? input.asof : to).map((window) => {
    const tsMs = Date.parse(window.start);
    const index = input.days.indexOf(window.start);
    const symbols = input.members[Math.max(0, index - 1)]!;
    const eligible = symbols.filter((symbol) => {
      const snapshot = valuationSnapshot(rows.get(symbol) ?? [], tsMs);
      return snapshot !== null && caps.get(tsMs)?.[symbol] !== undefined
        && lowPerHighRoeRankStrategy.dataRequirements!.fundamentalsReady!(snapshot, tsMs, p);
    });
    return { start: window.start, members: symbols.length, eligible: eligible.length, fraction: eligible.length / symbols.length, symbols: eligible };
  });
  return { stage, count: windows.length, anyData: windows.filter((r) => r.eligible > 0).length,
    majorityData: windows.filter((r) => r.fraction >= .5).length,
    min: Math.min(...windows.map((r) => r.eligible)), max: Math.max(...windows.map((r) => r.eligible)), windows };
});
const output = { description: '성과 계산 전에 필수 재무·시가총액만 확인한다. 수익성 조건을 만족하지 않아도 자료가 있으면 충족으로 센다.', stages };
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(stages.map(({ windows, ...summary }) => ({ ...summary, firstAvailable: windows.find((r) => r.eligible > 0)?.start })))}\n`);
