/**
 * E2E 테스트 서버: 임시 데이터 디렉터리에 관리자·데이터셋을 시드하고
 * 빌드된 SPA(dist/public)를 서빙하는 실제 서버를 3100 포트에 띄운다.
 * 실행 전 `pnpm build` 가 필요하다 (package.json test:e2e 참고).
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../src/server/bootstrap/config.js';
import { createContainer, type Container } from '../src/server/bootstrap/container.js';
import { buildServer } from '../src/server/bootstrap/server.js';
import { newId } from '../src/server/shared/ids.js';

export const E2E_USERNAME = 'e2e-operator';
export const E2E_PASSWORD = 'correct-horse-battery-staple';

const DAY = 86_400_000;

// 종목 마스터·유니버스 규칙 e2e(스펙 2026-08-05) — 가짜 KRX Open API 서버가 쓰는 고정값.
const KRX_FAKE_PORT = 3101;
const KRX_API_KEY = 'e2e-krx-key';

function krxEnvelope(rows: readonly Record<string, unknown>[]): {
  OutBlock_1: readonly Record<string, unknown>[];
} {
  return { OutBlock_1: rows };
}

/**
 * 보통주 1(005930, 시가총액 1위) + 우선주 1(분류 단계에서 제외) + 상장폐지 가정
 * 종목 1(900010, 가격 없음). 900010 은 KRX 기본정보에는 남아 있지만(과거엔 상장)
 * 최근 캔들이 전혀 없어 시가총액은 005930 보다 작게 잡아 둔다 — 위저드가 상위 N=1
 * 로 유니버스를 고르면 자연히 순위 밖으로 빠져, "봉이 없는 종목이 유니버스에
 * 섞이는" 경로(missingCandleSymbols)는 topN 을 늘리는 시나리오에서만 재현된다.
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

/**
 * 900010(상장폐지예정1호) 은 날짜와 무관하게 고정된 시세를 낸다 — 이 스위트가
 * 900010 에서 보는 건 "봉이 존재하는가" 뿐이고 정확한 가격 수준은 검증하지 않는다.
 * 시가총액은 005930 보다 항상 낮게 잡아 topN=1 선정에서 자연히 빠지게 한다.
 */
const DELISTED_DAILY_ROW = {
  ISU_CD: '900010',
  ISU_NM: '상장폐지예정1호',
  MKTCAP: '10,000,000,000,000',
  TDD_OPNPRC: '9,500',
  TDD_HGPRC: '9,800',
  TDD_LWPRC: '9,300',
  TDD_CLSPRC: '9,600',
  ACC_TRDVOL: '543,210',
};

/** 정수를 KRX 응답처럼 천 단위 콤마 문자열로 만든다 (parseNullableIntNumber 가 그 형식을 기대한다) */
function krxInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * 005930 의 종가가 그리는 추세 — 꾸준한 상승(하루 `TREND_DAILY_DRIFT`)에 삼각파
 * 잔물결을 얹는다(주기 `TREND_RIPPLE_DAYS`, 진폭 `TREND_RIPPLE_AMPLITUDE`).
 * 잔물결은 주기 경계에서 값이 끊기지 않는 연속 함수다. 하루짜리 큰 갭이 생기면
 * 그날의 변동폭(ATR)이 과장돼 손절·익절 판정 폭 자체가 늘어나 버리기 때문이다.
 * `basDd`(YYYYMMDD)를 기준 앵커(2026-01-05)로부터의 달력일 수로 환산해 순수
 * 함수로 계산한다 — 어느 순서로 어느 날짜를 조회하든(백필은 날짜 순, 개별
 * 소급은 거꾸로) 같은 날짜는 항상 같은 값을 낸다.
 *
 * 앵커 이전 날짜(다른 스펙이 쓰는 과거 날짜)는 경과일을 0 에 고정한다. 드리프트를
 * 과거로 무한히 되돌리면 가격이 0 이하로 떨어질 수 있기 때문이다. 그 스펙들은
 * 가격 수준을 검증하지 않으므로 항상 앵커 시점 모양을 반복해도 상관없다.
 *
 * 이 전략은 전고점 돌파(lookbackBars=10, atrPeriod=5)다.
 * mvp-flow.spec.ts 는 익절 폭도 3배로 지정한다.
 * 여러 번 매수·매도를 반복하려면 진입할 때마다 몇 거래일 안에 익절·손절
 * 중 하나에 닿아야 한다. 꾸준한 드리프트가 익절까지 걸리는 날수를 짧게
 * 만든다. 잔물결의 하강 구간이 이따금 손절도 만든다.
 *
 * 예전에는 CSV 로 심은 1분봉 추세가 이 역할을 했다.
 * CSV 가져오기가 제거되며(Task 5) 그 경로가 사라졌다.
 * 이제 백테스트가 소비하는 유일한 봉(KRX 일봉)이 이 추세를 대신 낸다.
 * 900010·카카오는 이 추세와 무관하다. 두 종목은 여전히 날짜와 무관한
 * 고정 시세를 낸다.
 */
const TREND_ANCHOR_MS = Date.UTC(2026, 0, 5);
const TREND_DAILY_DRIFT = 1_600;
const TREND_RIPPLE_DAYS = 6;
const TREND_RIPPLE_AMPLITUDE = 1_200;

/** 진폭 amplitude, 주기 period 인 삼각파 — t=0 과 t=period 에서 값이 이어진다(불연속 없음) */
function triangleWave(t: number, period: number, amplitude: number): number {
  const half = period / 2;
  const phase = ((t % period) + period) % period;
  const upSlope = phase <= half ? phase / half : (period - phase) / half;
  return (upSlope * 2 - 1) * amplitude;
}

function samsungCloseFor(basDd: string): number {
  const year = Number(basDd.slice(0, 4));
  const month = Number(basDd.slice(4, 6));
  const day = Number(basDd.slice(6, 8));
  const rawElapsedDays = Math.floor((Date.UTC(year, month - 1, day) - TREND_ANCHOR_MS) / DAY);
  const elapsedDays = Math.max(0, rawElapsedDays);
  const ripple = triangleWave(elapsedDays, TREND_RIPPLE_DAYS, TREND_RIPPLE_AMPLITUDE);
  return 70_000 + elapsedDays * TREND_DAILY_DRIFT + ripple;
}

/** 005930 일별시세 행 — 종가는 추세를 따르고 시가총액은 날짜와 무관하게 고정한다 */
function samsungDailyRow(basDd: string): Record<string, unknown> {
  const close = samsungCloseFor(basDd);
  const open = close - 500;
  const high = Math.max(open, close) + 500;
  const low = Math.min(open, close) - 500;
  return {
    ISU_CD: '005930',
    ISU_NM: '삼성전자',
    MKTCAP: '350,000,000,000,000',
    TDD_OPNPRC: krxInt(open),
    TDD_HGPRC: krxInt(high),
    TDD_LWPRC: krxInt(low),
    TDD_CLSPRC: krxInt(close),
    ACC_TRDVOL: '12,345,678',
  };
}

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

const KOSDAQ_DAILY_ROWS = [
  {
    ISU_CD: '035720',
    ISU_NM: '카카오',
    MKTCAP: '20,000,000,000,000',
    TDD_OPNPRC: '45,000',
    TDD_HGPRC: '46,000',
    TDD_LWPRC: '44,500',
    TDD_CLSPRC: '45,700',
    ACC_TRDVOL: '2,345,678',
  },
];

/**
 * 자본변동 미수집 게이트(Task 6, 설계 2026-08-08-corporate-action-continuity)가
 * e2e 제출을 막지 않도록, 종목이 등록될 때마다 자본변동 커버리지를 함께 심는다.
 *
 * 가짜 DART 서버를 새로 만드는 대신 이 방법을 골랐다.
 * 이 스위트는 DART 응답 파싱이 아니라 위저드 흐름을 검증한다.
 * `corp_code` 매핑과 재무제표 형식까지 갖춘 가짜 DART 서버는 유지 비용만 키운다.
 * 자본변동 수집 자체의 정확성은 `src/server/modules/facts` 의
 * 단위·통합 테스트가 맡는다.
 *
 * 부팅 시점에 한 번만 심지 않고 등록 시점마다 심는 이유는 등록·해제가
 * 반복되기 때문이다.
 * `mvp-flow.spec.ts` 의 상장폐지 시나리오는 900010 을 등록했다가 시나리오
 * 끝에서 지운다.
 * `symbols` 삭제는 외래키 `cascade` 로 `symbol_facts_state` 행도 함께 지운다.
 * 부팅 시점에만 심으면 그 삭제로 커버리지도 같이 사라진다.
 * 그러면 다음 프로젝트(desktop)가 같은 종목을 다시 등록해 제출할 때
 * 게이트가 다시 막는다 — 실제로 이 순서로 재현된 실패다.
 * `addSymbol` 호출마다 다시 심으면 등록·해제를 몇 번 반복해도 커버리지가
 * 항상 함께 붙는다.
 *
 * 연도 범위(2000~2035)는 이 저장소 e2e 시나리오가 쓰는 모든 기간을 덮는다.
 * 새 시나리오가 이 범위 밖 기간으로 백테스트를 제출하면 범위도 함께 넓혀야 한다.
 */
function seedCorporateActionCoverageOnRegistration(container: Container): void {
  const years = Array.from({ length: 36 }, (_, index) => 2000 + index);
  const originalAddSymbol = container.symbolService.addSymbol.bind(container.symbolService);
  container.symbolService.addSymbol = (code, market, name = null, standardCode = null) => {
    const summary = originalAddSymbol(code, market, name, standardCode);
    container.actionCoverageStore.addCoveredYears(code, years, container.clock.now());
    return summary;
  };
}

/**
 * 리밸런스 적용 거래일 표기 e2e(Task 4, 2026-08-06 스펙, `tests/e2e/mvp-flow.spec.ts`
 * `holidayPeriodFor`)가 정확히 이 두 날짜만 휴장 리밸런스로 쓴다 — mobile·desktop
 * 프로젝트가 같은 서버 상태를 공유해도(playwright.config workers:1) 부딪히지
 * 않도록 연도를 갈랐다.
 *
 * "1월 1일이면 무조건 휴장" 같은 패턴 매칭 대신 이 정확한 날짜 집합만 겨냥한다 —
 * 패턴으로 두면 `tests/e2e/symbol-master.spec.ts` 가 쓰는 "오늘 기준 상대 날짜"
 * (`daysBeforeIso(todayIso(), 1|10)`)가 매년 1월 2일·1월 11일에 이 스위트를 돌릴 때
 * 우연히 1월 1일과 겹쳐, 그 스펙의 "가짜 KRX 는 어느 날짜를 물어도 같은 유니버스
 * 구성을 낸다"는 전제를 깨뜨린다(리뷰에서 지적된 회귀). 고정 날짜 집합은 상대 날짜를
 * 쓰는 스펙과 영원히 부딪히지 않는다.
 */
const HOLIDAY_BAS_DATES = new Set(['20250101', '20180101']);

function isHolidayBasDd(basDd: string | undefined): boolean {
  return basDd !== undefined && HOLIDAY_BAS_DATES.has(basDd);
}

/**
 * e2e 전용 가짜 KRX Open API 서버.
 *
 * 기본정보(base_info)는 요청한 날짜와 무관하게 항상 같은 값을 돌려준다. 일별시세
 * (daily_trd) 도 원칙은 같지만 두 가지 예외가 있다.
 *
 * 하나는 HOLIDAY_BAS_DATES 에 속한 날짜의 빈 배열이다. 두 시장 모두 거래가 없는
 * 날로 잡혀야 SymbolMasterService.ingestDate 가 휴장으로 분류한다. 그래야
 * ensureTradingDay 의 소급 수집도 재현할 수 있다.
 *
 * 다른 하나는 005930 의 가격(OHLCV)이다 — `samsungCloseFor` 가 설명하듯 날짜에
 * 따라 추세를 그린다. 시가총액·종목명은 005930 을 포함해 모든 종목이 날짜와
 * 무관하게 고정이다. 그래서 유니버스 구성·분류·topN 선정을 겨냥한 스펙
 * (symbol-master.spec.ts 등)은 이 가격 추세와 무관하다.
 *
 * 종목 마스터는 요청한 날짜를 그대로 조회할 뿐 예전 KRX 과거 유니버스 경로가 하던
 * '휴장일이면 과거로 소급' 탐색을 하지 않는다. 그 경로는 스펙 2026-08-05 Task 6
 * 에서 데이터셋·스냅샷과 함께 제거됐다. 그래서 소급은 이제 ensureTradingDay
 * 쪽 책임이고, 이 스텁은 "그 날이 휴장이었다"는 사실 하나만 재현하면 된다.
 */
async function startFakeKrxServer(): Promise<void> {
  const app = Fastify({ logger: false });
  app.get('/svc/apis/sto/stk_isu_base_info', async () => krxEnvelope(KOSPI_BASE_ROWS));
  app.get('/svc/apis/sto/ksq_isu_base_info', async () => krxEnvelope(KOSDAQ_BASE_ROWS));
  app.get('/svc/apis/sto/stk_bydd_trd', async (request) => {
    const { basDd } = request.query as { basDd?: string };
    if (isHolidayBasDd(basDd)) return krxEnvelope([]);
    return krxEnvelope([samsungDailyRow(basDd ?? '20260105'), DELISTED_DAILY_ROW]);
  });
  app.get('/svc/apis/sto/ksq_bydd_trd', async (request) => {
    const { basDd } = request.query as { basDd?: string };
    return krxEnvelope(isHolidayBasDd(basDd) ? [] : KOSDAQ_DAILY_ROWS);
  });
  await app.listen({ host: '127.0.0.1', port: KRX_FAKE_PORT });
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
      totpLastUsedStep: null,
      recoveryCodeHashes: [],
    },
    container.clock.now(),
  );

  // e2e 픽스처 봉은 더 이상 여기서 직접 심지 않는다.
  // Task 5 가 `symbolService.importCsv` 를 지웠다(스펙 2026-08-07-price-data-removal).
  // 대신 가짜 KRX 서버가 005930 에 추세 있는 일별 시세를 낸다(`samsungCloseFor` 참고).
  // 위저드의 '미리보기'·'기간 전체 동기화'가 그 시세를 `krx_daily_bars` 에 적재한다.
  // 종목 등록도 그 미리보기 응답이 자동으로 한다.
  // 그 등록 로직은 backtest-routes.ts 의 registerUniverseSymbols 다.
  // 위저드를 통과하는 e2e 흐름은 별도 등록이 필요 없다.
  //
  // 다만 그 등록 경로에 자본변동 커버리지 심기를 여기서 붙인다
  // (seedCorporateActionCoverageOnRegistration 주석 참고).
  // 붙이지 않으면 Task 6 게이트가 모든 e2e 백테스트 제출을 400 으로 막는다.
  seedCorporateActionCoverageOnRegistration(container);
  const app = await buildServer(container);
  await app.listen({ host: config.bindAddress, port: config.port });
  container.jobOrchestrator.start();
  console.log(`e2e server ready on http://127.0.0.1:${config.port}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
