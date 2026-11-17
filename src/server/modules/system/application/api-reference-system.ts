import { z } from 'zod';
import { agentClientStatusSchema } from '../../../../shared/agent-status.js';
import { openApiTokenIssueSchema } from '../../../../shared/schemas/openapi-token.js';
import type { ApiEndpoint, ApiParameter } from '../../../../shared/schemas/api-reference.js';
import type { ApiReferenceMetadata } from './api-reference.js';

const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input' }) as Record<string, unknown>;
const body = (description: string, value: z.ZodType, example?: unknown) => ({ contentType: 'application/json', description, schema: schema(value), ...(example === undefined ? {} : { example }) });
const response = (status: number, description: string, value?: z.ZodType, example?: unknown): ApiEndpoint['responses'][number] => ({ status, description, ...(status === 204 ? {} : { contentType: 'application/json' }), ...(value ? { schema: schema(value) } : {}), ...(example === undefined ? {} : { example }) });
const status = z.object({ status: z.string() });
const tokenRecord = z.object({ id: z.string(), name: z.string(), prefix: z.string(), scope: z.enum(['READ_ONLY', 'READ_WRITE']), createdAtMs: z.number(), expiresAtMs: z.number(), lastUsedAtMs: z.number().nullable(), revokedAtMs: z.number().nullable() });
const header = (name: string, type: string, description: string, required = true): ApiParameter => ({ name, in: 'header', type, required, description });

export const systemApiMetadata: Record<string, ApiReferenceMetadata> = {
  'GET /api/v1/jobs': {
    title: '작업 목록', description: '보관 기간과 사용자별 숨김 상태를 반영하여 작업을 조회합니다. 오류 필터는 실패(FAILED)와 비정상 중단(INTERRUPTED)을 포함합니다.',
    parameters: [
      { name: 'status', in: 'query', type: 'all | active | finished | error', required: false, description: '기본 all. error이면 오류가 발생한 작업만 조회합니다.', example: 'error' },
      { name: 'limit', in: 'query', type: 'integer', required: false, description: '페이지 크기 1~100, 기본 50.' },
      { name: 'offset', in: 'query', type: 'integer', required: false, description: '조회 시작 위치 0~1000000, 기본 0. 범위를 넘으면 마지막 페이지로 조정됩니다.' },
    ],
    responses: [response(200, 'jobs, total, activeCount, retentionDays, limit, offset. total은 필터 적용 후 개수이며 activeCount는 전체 진행 작업 개수입니다.'), response(400, '지원하지 않는 필터 또는 페이지 값.')],
  },
  'GET /api/v1/notifications': {
    title: '알림 목록', description: '최신순으로 최대 200개를 조회합니다. severity를 지정하면 해당 심각도의 알림을 먼저 필터링한 뒤 조회 상한을 적용합니다.',
    parameters: [{ name: 'severity', in: 'query', type: 'info | error', required: false, description: '생략하면 전체 알림, error이면 오류 알림만 조회합니다.', example: 'error' }],
    responses: [response(200, 'notifications 배열. 각 항목은 id, type, severity, title, body, link, read, createdAtMs를 포함합니다.'), response(400, '지원하지 않는 severity 값.')],
  },
  'POST /api/v1/auth/login': {
    title: '로그인', authentication: 'PUBLIC', description: '암호를 확인하고 서명된 HttpOnly 세션 쿠키를 발급합니다. TOTP_REQUIRED이면 추가 인증이 필요합니다.',
    requestBody: body('사용자 이름과 암호.', z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) })),
    responses: [response(200, 'Set-Cookie: session. status는 OK 또는 TOTP_REQUIRED.', status), response(400, '요청 형식 오류.'), response(401, '아이디 또는 암호 오류.'), response(429, '로그인 실패 누적 잠금.')],
  },
  'POST /api/v1/auth/totp/verify': {
    title: '추가 인증', authentication: 'SESSION', description: '진행 중인 로그인 세션에서 일회용 인증 코드를 확인하고 세션 ID를 교체합니다.',
    requestBody: body('인증 코드 또는 복구 코드.', z.object({ token: z.string().min(6).max(64) })),
    responses: [response(200, 'status OK와 인증 완료 세션 쿠키.', status), response(400, '요청 형식 오류.'), response(401, '세션 또는 코드 오류.'), response(429, '실패 누적 잠금.')],
  },
  'POST /api/v1/auth/logout': { title: '로그아웃', authentication: 'PUBLIC', description: '요청의 세션 쿠키가 있으면 해당 세션을 폐기하고 쿠키를 삭제합니다. OpenAPI 토큰을 폐기하지 않습니다.', responses: [response(200, 'status OK.', status, { status: 'OK' })] },
  'GET /api/v1/auth/me': { title: '세션 사용자 조회', authentication: 'SESSION', description: '추가 인증까지 마친 브라우저 세션의 사용자를 조회합니다.', responses: [response(200, '현재 사용자.', z.object({ id: z.string(), username: z.string() }))] },
  'GET /api/v1/health/live': { title: '프로세스 상태', authentication: 'PUBLIC', description: '프로세스의 생존 상태를 조회합니다.', responses: [response(200, 'status ok.', status, { status: 'ok' })] },
  'GET /api/v1/health/ready': { title: '서비스 준비 상태', authentication: 'PUBLIC', description: '운영 DB 조회와 데이터 디렉터리 쓰기 가능 여부를 검사합니다.', responses: [response(200, '준비 완료.', status, { status: 'ready' }), response(503, '준비되지 않음.', status, { status: 'not_ready' })] },
  'GET /api/v1/system/info': { title: '서버 정보', description: '버전, 가용 자원과 작업 현황을 조회합니다. 비밀값과 민감 경로는 포함하지 않습니다.', responses: [response(200, '바이트 단위 자원과 작업 개수.', z.object({ name: z.string(), version: z.string(), gitCommitSha: z.string().nullable(), uptimeSeconds: z.number(), databaseSizeBytes: z.number(), freeDiskBytes: z.number().nullable(), freeMemoryBytes: z.number(), queueLength: z.number(), runningJobs: z.number(), registeredSymbolCount: z.number() }))] },
  'GET /api/v1/system/api-reference': { title: '전체 API 명세', description: '현재 서버에 등록된 API의 메서드, 경로, 인증, 요청과 응답 계약을 조회합니다. 설정의 API 명세 페이지도 이 자료를 사용합니다.', responses: [response(200, 'version, generatedAtMs, basePath, authentication와 endpoints 배열. 각 항목은 id, method, path, group, title, description, authentication, parameters, 선택적 requestBody와 responses를 포함합니다.')] },
  'GET /api/v1/openapi-tokens': { title: 'OpenAPI 토큰 목록', authentication: 'SESSION', description: '현재 사용자의 토큰 메타데이터를 조회합니다. 원문과 해시는 반환하지 않습니다.', responses: [response(200, '폐기되지 않은 유효·만료 토큰 목록.', z.object({ tokens: z.array(tokenRecord) })), response(403, 'Bearer 인증으로 토큰을 관리할 수 없습니다.')] },
  'POST /api/v1/openapi-tokens': {
    title: 'OpenAPI 토큰 발급', authentication: 'SESSION', description: '기본 유효기간은 365일이며 1~3650일을 지정할 수 있습니다. 원문은 이 응답에서 한 번만 표시하며 DB에는 해시만 저장합니다. 사용자당 유효 토큰 최대 100개.',
    requestBody: body('name은 필수입니다. 기본 scope는 READ_WRITE이며 READ_ONLY는 GET/HEAD/OPTIONS만 허용합니다.', openApiTokenIssueSchema, { name: '로컬 AI', scope: 'READ_WRITE', expiresInDays: 365 }),
    responses: [response(201, 'token을 안전하게 보관한 후 Authorization: Bearer <token>으로 전송합니다.', z.object({ token: z.string(), record: tokenRecord })), response(400, '요청 형식 오류.'), response(403, '로그인 세션에서만 발급 가능합니다.'), response(409, '유효 토큰 한도 초과.')],
  },
  'DELETE /api/v1/openapi-tokens/:id': { title: 'OpenAPI 토큰 폐기', authentication: 'SESSION', description: '현재 사용자 소유의 토큰을 즉시 폐기하고 저장 기록을 삭제합니다. 삭제한 토큰은 인증할 수 없으며 목록에도 남지 않습니다.', responses: [response(204, '폐기 완료.'), response(403, '로그인 세션에서만 폐기 가능합니다.'), response(404, '본인 소유 토큰이 없거나 이미 삭제됨.')] },
  'GET /api/v1/agents': { title: '에이전트 목록', authentication: 'SESSION', description: '등록된 에이전트의 실행 가능 여부, 차단 사유, 마지막 보고 버전과 현재 요구 버전을 조회합니다. 최근 통신 시각은 작업 실행 가능 여부와 별개입니다. OpenAPI 토큰과 별개의 자격증명입니다.', responses: [response(200, 'clients 목록. execution에 현재 실행 상태와 사유를 포함합니다.', z.object({ clients: z.array(agentClientStatusSchema) })), response(403, '로그인 세션이 필요합니다.')] },
  'POST /api/v1/agents': { title: '에이전트 토큰 발급', authentication: 'SESSION', description: '실행 에이전트 전송 전용 토큰을 발급합니다. OpenAPI 토큰으로 발급할 수 없습니다.', requestBody: body('장치 이름.', z.object({ name: z.string().trim().min(1).max(80) })), responses: [response(200, 'token 원문은 발급 응답에만 포함됩니다.', z.object({ id: z.string(), name: z.string(), token: z.string() })), response(400, '요청 형식 오류.'), response(403, '로그인 세션이 필요합니다.')] },
  'POST /api/v1/agents/install/windows': { title: 'Windows 에이전트 설치 파일', authentication: 'SESSION', description: '유효한 에이전트 토큰과 서버 주소가 포함된 설치 파일을 내려받습니다. 파일을 비밀정보로 취급하세요.', requestBody: body('기존 Agent 토큰과 서버 원점 URL.', z.object({ token: z.string().min(32).max(256), serverUrl: z.string().max(2048) })), responses: [{ status: 200, description: 'quant-agent-windows.cmd 첨부 파일. Cache-Control: no-store.', contentType: 'application/octet-stream' }, response(400, '잘못된 주소 또는 본문.'), response(401, '유효한 에이전트 토큰이 필요합니다.'), response(403, '로그인 세션이 필요합니다.')] },
  'DELETE /api/v1/agents/:id': { title: '에이전트 토큰 폐기', authentication: 'SESSION', description: '등록된 에이전트의 자격증명을 폐기합니다.', responses: [response(200, 'status REVOKED.', status, { status: 'REVOKED' }), response(404, '장치 없음.'), response(403, '로그인 세션이 필요합니다.')] },
  'GET /api/agents/connect': { title: '에이전트 WebSocket 연결', authentication: 'AGENT_TOKEN', description: '별도의 에이전트 토큰으로 인증한 뒤 작업 임대·진행·하트비트 프로토콜을 교환합니다. OpenAPI 토큰은 사용할 수 없습니다.', parameters: [header('Authorization', 'string', 'Bearer <AGENT_TOKEN>')], responses: [{ status: 101, description: 'WebSocket 프로토콜 전환.' }] },
  'GET /api/agents/datasets/:version': { title: '에이전트 데이터셋 다운로드', authentication: 'AGENT_TOKEN', description: '양의 정수 version에 해당하는 게시된 SQLite 데이터셋을 내려받습니다. ETag는 SHA-256이며 Content-Length는 파일 크기입니다.', responses: [{ status: 200, description: 'SQLite 파일 스트림.', contentType: 'application/vnd.sqlite3' }, response(400, '버전 형식 오류.'), response(404, '게시된 버전 또는 파일 없음.')] },
  'POST /api/agents/jobs/:jobId/result': { title: '에이전트 결과 업로드', authentication: 'AGENT_TOKEN', description: '현재 에이전트가 임대한 작업의 SQLite 결과 파일을 업로드합니다. 해시·크기·임대와 결과 계약을 검증합니다.', parameters: [header('x-agent-attempt', 'integer', '양의 정수 시도 번호.'), header('x-agent-lease-token', 'string', '32~256자 작업 임대 토큰.'), header('x-content-sha256', 'string', '파일 SHA-256 소문자 64자리.'), header('Content-Length', 'integer', '양의 정수 파일 바이트 크기.'), header('x-agent-telemetry', 'string', '선택적 실행 관측 JSON, 8192자 미만.', false)], requestBody: { contentType: 'application/vnd.quant-platform.backtest-result+sqlite', description: 'SQLite 결과 아티팩트의 바이너리 스트림.' }, responses: [response(200, 'status ACCEPTED 또는 IDEMPOTENT.', status), response(400, '헤더 형식 또는 파일 길이·해시 불일치.'), response(409, 'STALE_LEASE 등 현재 임대로 수락할 수 없음.'), response(413, '결과 파일 상한 초과.'), response(415, '결과 파일 형식 오류.'), response(422, '결과 검증 실패.')] },
};
