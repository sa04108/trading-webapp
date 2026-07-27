/**
 * E2E 테스트 서버: 임시 데이터 디렉터리에 관리자·데이터셋을 시드하고
 * 빌드된 SPA(dist/public)를 서빙하는 실제 서버를 3100 포트에 띄운다.
 * 실행 전 `pnpm build` 가 필요하다 (package.json test:e2e 참고).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/bootstrap/config.js';
import { createContainer } from '../src/server/bootstrap/container.js';
import { buildServer } from '../src/server/bootstrap/server.js';
import { newId } from '../src/server/shared/ids.js';

export const E2E_USERNAME = 'e2e-operator';
export const E2E_PASSWORD = 'correct-horse-battery-staple';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function buildTrendingHourlyCsv(): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  let tradingDays = 0;
  let dayCursor = Date.UTC(2026, 0, 5);
  const baseForDay = (day: number): number => {
    if (day < 15) return 100 + day * 5;
    if (day < 23) return 170 - (day - 14) * 6;
    return 122 + (day - 22) * 5;
  };
  while (tradingDays < 30) {
    const dow = new Date(dayCursor).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const base = baseForDay(tradingDays);
      for (let barIndex = 0; barIndex < 7; barIndex += 1) {
        const ts = dayCursor + barIndex * HOUR;
        const open = base + barIndex * 0.3;
        const close = open + 0.5;
        lines.push(`${ts},${open},${close + 0.1},${open - 0.6},${close},1000`);
      }
      tradingDays += 1;
    }
    dayCursor += DAY;
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const root = path.resolve('.e2e-data');
  fs.rmSync(root, { recursive: true, force: true });

  const config = loadConfig({
    NODE_ENV: 'test',
    APP_PORT: '3100',
    DATABASE_PATH: path.join(root, 'app.sqlite'),
    DATA_ROOT: path.join(root, 'market-data'),
    IMPORT_ROOT: path.join(root, 'imports'),
    EXPORT_ROOT: path.join(root, 'exports'),
    TEMP_ROOT: path.join(root, 'temp'),
    SESSION_SECRET: 'e2e-'.repeat(12),
    LOG_LEVEL: 'warn',
  });
  const container = createContainer(config);

  container.userRepository.create(
    {
      id: newId('usr'),
      username: E2E_USERNAME,
      passwordHash: await container.passwordHasher.hash(E2E_PASSWORD),
      totpSecret: null,
      totpEnabled: false,
      recoveryCodeHashes: [],
    },
    container.clock.now(),
  );

  await container.datasetService.importCsv({
    datasetName: 'kr-hourly-v1',
    market: 'KR',
    timeframe: '1h',
    symbol: '005930',
    fileName: 'e2e.csv',
    csvContent: buildTrendingHourlyCsv(),
  });

  const app = await buildServer(container);
  await app.listen({ host: config.bindAddress, port: config.port });
  container.jobOrchestrator.start();
  console.log(`e2e server ready on http://127.0.0.1:${config.port}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
