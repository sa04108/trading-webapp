import Fastify from 'fastify';

type KrxRawRow = Record<string, unknown>;

export function krxEnvelope(rows: readonly KrxRawRow[]): { OutBlock_1: readonly KrxRawRow[] } {
  return { OutBlock_1: rows };
}

export function krxJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function baseInfoFixture(overrides: KrxRawRow = {}): KrxRawRow {
  return {
    ISU_CD: 'KR7005930003',
    ISU_SRT_CD: '005930',
    ISU_NM: '삼성전자',
    LIST_DD: '19750611',
    MKT_TP_NM: 'KOSPI',
    SECUGRP_NM: '주권',
    SECT_TP_NM: '대형주',
    KIND_STKCERT_TP_NM: '보통주',
    ...overrides,
  };
}

export function dailyFixture(overrides: KrxRawRow = {}): KrxRawRow {
  return {
    ISU_CD: '005930',
    ISU_NM: '삼성전자',
    MKTCAP: '350,000,000,000,000',
    ...overrides,
  };
}

/** 실제 어댑터가 두는 시장별 경로 (krx-historical-universe-source.ts 의 PATHS 와 맞춘다). */
export type KrxFakePath = 'stk_isu_base_info' | 'stk_bydd_trd' | 'ksq_isu_base_info' | 'ksq_bydd_trd';

const KRX_FAKE_PATHS: readonly KrxFakePath[] = [
  'stk_isu_base_info',
  'stk_bydd_trd',
  'ksq_isu_base_info',
  'ksq_bydd_trd',
];

export interface KrxFakeRequest {
  readonly path: KrxFakePath;
  readonly basDd: string;
  readonly authKey: string | undefined;
}

export interface KrxFakeResponse {
  readonly status?: number;
  readonly body: unknown;
}

export interface KrxFakeServer {
  readonly baseUrl: string;
  readonly requests: readonly KrxFakeRequest[];
  /** basDd 별 canned 응답. 미설정 조합은 빈 OutBlock_1 을 돌려준다. */
  setResponse(path: KrxFakePath, basDd: string, response: KrxFakeResponse): void;
  close(): Promise<void>;
}

/**
 * 실제 HTTP 로 응답하는 fake KRX 서버 — `KrxHistoricalUniverseSource` 가 쓰는 real
 * `fetch` 경로(조립부 wiring)를 통합 테스트가 그대로 태울 수 있게 한다. 4 경로를
 * 전부 서빙하고 수신한 요청(경로·basDd·AUTH_KEY)을 기록한다.
 */
export async function startKrxFakeServer(): Promise<KrxFakeServer> {
  const app = Fastify({ logger: false });
  const requests: KrxFakeRequest[] = [];
  const responses = new Map<string, KrxFakeResponse>();

  for (const path of KRX_FAKE_PATHS) {
    app.get(`/svc/apis/sto/${path}`, async (request, reply) => {
      const basDd = (request.query as { basDd?: string }).basDd ?? '';
      const authKey = request.headers['auth_key'] as string | undefined;
      requests.push({ path, basDd, authKey });
      const canned = responses.get(`${path}:${basDd}`) ?? { body: krxEnvelope([]) };
      return reply.code(canned.status ?? 200).send(canned.body);
    });
  }

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setResponse(path, basDd, response) {
      responses.set(`${path}:${basDd}`, response);
    },
    close: () => app.close(),
  };
}
