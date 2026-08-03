/**
 * E2E 테스트 서버: 임시 데이터 디렉터리에 관리자·데이터셋을 시드하고
 * 빌드된 SPA(dist/public)를 서빙하는 실제 서버를 3100 포트에 띄운다.
 * 실행 전 `pnpm build` 가 필요하다 (package.json test:e2e 참고).
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../src/server/bootstrap/config.js';
import { createContainer } from '../src/server/bootstrap/container.js';
import { buildServer } from '../src/server/bootstrap/server.js';
import { newId } from '../src/server/shared/ids.js';

export const E2E_USERNAME = 'e2e-operator';
export const E2E_PASSWORD = 'correct-horse-battery-staple';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// KRX 과거 유니버스 e2e(Task 15) — 가짜 KRX Open API 서버가 쓰는 고정값.
const KRX_FAKE_PORT = 3101;
const KRX_API_KEY = 'e2e-krx-key';
/** 유일하게 값이 있는 거래일. 2025-01-01 조회가 이 날로 소급되는 것으로 '적용일' 을 검증한다. */
const KRX_TRADING_BASDD = '20241230';

function krxEnvelope(rows: readonly Record<string, unknown>[]): {
  OutBlock_1: readonly Record<string, unknown>[];
} {
  return { OutBlock_1: rows };
}

/**
 * 보통주 1(005930, 1위) + 우선주 1(제외) + 상장폐지 가정 종목 1(900010, 가격 없음).
 * 900010 은 KRX 기본정보에는 남아 있지만(과거엔 상장) 최근 캔들이 전혀 없어 "가격
 * 데이터가 없는 스냅샷 종목" 차단 시나리오의 재료가 된다.
 */
const KOSPI_BASE_ROWS = [
  {
    ISU_CD: 'KR7005930003',
    ISU_SRT_CD: '005930',
    ISU_NM: '삼성전자',
    LIST_DD: '19750611',
    MKT_TP_NM: 'KOSPI',
    SECUGRP_NM: '주권',
    SECT_TP_NM: null,
    KIND_STKCERT_TP_NM: '보통주',
  },
  {
    ISU_CD: 'KR7005935008',
    ISU_SRT_CD: '005935',
    ISU_NM: '삼성전자우',
    LIST_DD: '19750611',
    MKT_TP_NM: 'KOSPI',
    SECUGRP_NM: '주권',
    SECT_TP_NM: null,
    KIND_STKCERT_TP_NM: '우선주',
  },
  {
    ISU_CD: 'KR7900010009',
    ISU_SRT_CD: '900010',
    ISU_NM: '상장폐지예정1호',
    LIST_DD: '20100104',
    MKT_TP_NM: 'KOSPI',
    SECUGRP_NM: '주권',
    SECT_TP_NM: null,
    KIND_STKCERT_TP_NM: '보통주',
  },
];

/** 005930·900010 만 시가총액을 갖는다 — 우선주는 분류 단계에서 이미 제외돼 일별 시세가 필요 없다. */
const KOSPI_DAILY_ROWS = [
  { ISU_CD: '005930', ISU_NM: '삼성전자', MKTCAP: '350,000,000,000,000' },
  { ISU_CD: '900010', ISU_NM: '상장폐지예정1호', MKTCAP: '10,000,000,000,000' },
];

/** 보통주 1(카카오) + 스팩 1(SECT_TP_NM 로 제외). */
const KOSDAQ_BASE_ROWS = [
  {
    ISU_CD: 'KR7035720002',
    ISU_SRT_CD: '035720',
    ISU_NM: '카카오',
    LIST_DD: '20170710',
    MKT_TP_NM: 'KOSDAQ',
    SECUGRP_NM: '주권',
    SECT_TP_NM: null,
    KIND_STKCERT_TP_NM: '보통주',
  },
  {
    ISU_CD: 'KR7900099001',
    ISU_SRT_CD: '900099',
    ISU_NM: '한국기업인수목적1호스팩',
    LIST_DD: '20230301',
    MKT_TP_NM: 'KOSDAQ',
    SECUGRP_NM: '주권',
    SECT_TP_NM: 'SPAC',
    KIND_STKCERT_TP_NM: '보통주',
  },
];

const KOSDAQ_DAILY_ROWS = [{ ISU_CD: '035720', ISU_NM: '카카오', MKTCAP: '20,000,000,000,000' }];

/**
 * e2e 전용 가짜 KRX Open API 서버.
 *
 * 기본정보(base_info)는 요청 날짜와 무관하게 항상 같은 값을 돌려준다 — 실 KRX 는
 * 상장 목록이 자주 바뀌지 않고, `UniverseSnapshotService.createFromPreview` 가
 * 기존에 등록된 종목(예: 005930)의 표준코드를 "오늘" 기준으로 재검증할 때도 같은
 * 응답을 재사용해야 한다. 검증 시점이 테스트 실행일이라 미리 날짜를 맞춰 둘 수
 * 없어서다. `tests/e2e/krx-universe.spec.ts` 가 CSV 가져오기 UI 로 직접 등록하는
 * 900010(상장폐지예정1호) 도 이 재검증을 그대로 통과해야 하므로 KOSPI_BASE_ROWS 에
 * 함께 둔다.
 *
 * 일별시세(daily_trd)는 거래일(2024-12-30)에만 값을 주고 그 외(2025-01-01 등 휴장일
 * 포함)는 빈 응답으로 남긴다 — '적용일 소급 탐색' 과 '휴장일 조회' 시나리오를 이
 * 비대칭으로 만든다.
 */
async function startFakeKrxServer(): Promise<void> {
  const app = Fastify({ logger: false });
  app.get('/svc/apis/sto/stk_isu_base_info', async () => krxEnvelope(KOSPI_BASE_ROWS));
  app.get('/svc/apis/sto/ksq_isu_base_info', async () => krxEnvelope(KOSDAQ_BASE_ROWS));
  app.get('/svc/apis/sto/stk_bydd_trd', async (request) => {
    const { basDd } = request.query as { basDd?: string };
    return krxEnvelope(basDd === KRX_TRADING_BASDD ? KOSPI_DAILY_ROWS : []);
  });
  app.get('/svc/apis/sto/ksq_bydd_trd', async (request) => {
    const { basDd } = request.query as { basDd?: string };
    return krxEnvelope(basDd === KRX_TRADING_BASDD ? KOSDAQ_DAILY_ROWS : []);
  });
  await app.listen({ host: '127.0.0.1', port: KRX_FAKE_PORT });
}

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

  // KRX 과거 유니버스 e2e(Task 15) — 앱 서버가 뜨기 전에 가짜 KRX 서버를 먼저 올린다.
  await startFakeKrxServer();

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
    KRX_API_KEY,
    KRX_BASE_URL: `http://127.0.0.1:${KRX_FAKE_PORT}`,
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

  // timeframe '1m' — 슬라이스 모델에서 available timeframe 은 실제 저장된 봉으로
  // 결정된다 (dataset.timeframe 고정 목록이 아니다). '1h' 로 직수입하면 1m 원본이
  // 전혀 없어 데이터 검증 드로어의 1m→1h 폴백이 빈 성공 응답 대신 400 을 받아
  // 깨진다. CSV 행은 이미 시간 경계에 맞춰져 있어 1m→1h 집계가 1:1 로 떨어진다.
  // 봉은 **종목**으로 들어간다 — CSV 는 종목을 등록하지만 데이터셋은 만들지 않는다
  // (설계 2026-07-31-symbol-as-first-class). 위저드가 고를 참조 묶음은 따로 만든다.
  await container.symbolService.importCsv({
    market: 'KR',
    timeframe: '1m',
    symbol: '005930',
    fileName: 'e2e.csv',
    csvContent: buildTrendingHourlyCsv(),
  });
  // 표시명은 라우트(`POST /symbols/import`)가 SymbolInfoService 로 채운다. 이 시드는
  // 서비스를 직접 부르므로 그 단계를 건너뛴다 — 실제 경로와 같은 상태를 만들려면
  // 여기서 이름을 넣어야 한다. (테스트의 `/symbols/info` 스텁은 브라우저 요청만 가로챈다.)
  container.symbolService.setName('005930', '삼성전자');
  container.datasetService.createDataset('kr-hourly-v1', ['005930']);

  const app = await buildServer(container);
  await app.listen({ host: config.bindAddress, port: config.port });
  container.jobOrchestrator.start();
  console.log(`e2e server ready on http://127.0.0.1:${config.port}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
