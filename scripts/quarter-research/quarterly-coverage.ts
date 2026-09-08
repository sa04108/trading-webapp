import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hasEightQuarters, quarterlySnapshot, type QuarterObservation } from './quarterly-earnings.js';
import { quarterWindows, STAGES, type ResearchInput } from './quarter-engine.js';

const [pricePath, observationsPath, outputPath] = process.argv.slice(2);
if (!pricePath || !observationsPath || !outputPath) throw new Error('사용법: quarterly-coverage.ts price-input.gz observations.json output.json');
const input = JSON.parse(gunzipSync(readFileSync(pricePath)).toString()) as ResearchInput;
const observations = JSON.parse(readFileSync(observationsPath, 'utf8')).observations as QuarterObservation[];
const rows = new Map<string, QuarterObservation[]>();
for (const observation of observations) {
  const list = rows.get(observation.symbol) ?? [];
  list.push(observation);
  rows.set(observation.symbol, list);
}
const result = Object.entries(STAGES).map(([stage, [from, to]]) => {
  const windows = quarterWindows(input.days, from, input.asof < to ? input.asof : to).map((window) => {
    const index = input.days.indexOf(window.start);
    const symbols = input.members[Math.max(0, index - 1)]!;
    const eligible = symbols.filter((symbol) => hasEightQuarters(quarterlySnapshot(rows.get(symbol) ?? [], Date.parse(window.start)), Date.parse(window.start)));
    return { start: window.start, members: symbols.length, eligible: eligible.length, fraction: eligible.length / symbols.length, symbols: eligible };
  });
  return { stage, count: windows.length, anyData: windows.filter((r) => r.eligible > 0).length,
    majorityData: windows.filter((r) => r.fraction >= .5).length,
    min: Math.min(...windows.map((r) => r.eligible)), max: Math.max(...windows.map((r) => r.eligible)), windows };
});
const output = { description: '성과 계산 전 시작 시점의 같은 회계기준 연속 8분기·신선도만 검사한다. 수익·가격 모멘텀 자격은 포함하지 않는다.', stages: result };
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result.map(({ windows, ...summary }) => ({ ...summary, firstAvailable: windows.find((r) => r.eligible > 0)?.start })))}\n`);
