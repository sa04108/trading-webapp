import type { FastifyInstance, RouteOptions } from 'fastify';
import { backtestApiMetadata } from './api-reference-backtest.js';
import { marketApiMetadata } from './api-reference-market.js';
import { systemApiMetadata } from './api-reference-system.js';
import { searchApiMetadata } from './api-reference-search.js';
import type { ApiEndpoint, ApiReference } from '../../../../shared/schemas/api-reference.js';

export type ApiReferenceMetadata = Partial<Pick<ApiEndpoint, 'title' | 'description' | 'authentication' | 'requestBody' | 'responses' | 'parameters'>>;
const known: Record<string, ApiReferenceMetadata> = { ...backtestApiMetadata, ...marketApiMetadata, ...systemApiMetadata, ...searchApiMetadata };
const groups: Record<string, string> = { auth: '인증', 'openapi-tokens': 'OpenAPI 토큰', benchmarks: '벤치마크', 'backtest-validations': '기간 검증', health: '상태', system: '시스템', backtests: '일봉 백테스트', 'backtest-clone-batches': '일봉 백테스트', 'configuration-searches': '설정 탐색', intraday: '분봉', trading: '실전 운용', agents: '에이전트', jobs: '작업', notifications: '알림', symbols: '종목', 'symbol-master': '종목 데이터', 'market-data': '시장 데이터', strategies: '전략', markets: '시장' };
export interface ApiReferenceStore { readonly routes: Map<string, RouteOptions> }
export function installApiReference(app: FastifyInstance): ApiReferenceStore {
  const store: ApiReferenceStore = { routes: new Map() };
  app.addHook('onRoute', (route) => {
    const path = route.url;
    if (!path.startsWith('/api/v1/') && !path.startsWith('/api/agents/')) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      store.routes.set(`${method} ${path}`, route);
    }
  });
  return store;
}
export function buildApiReference(store: ApiReferenceStore): ApiReference {
  const endpoints = [...store.routes.keys()].sort().map(key => {
    const space = key.indexOf(' '), method = key.slice(0, space), path = key.slice(space + 1);
    const metadata = known[key];
    const part = path.startsWith('/api/agents/') ? 'agents' : path.split('/')[3] ?? 'system';
    const group = groups[part] ?? '기타';
    const authentication = metadata?.authentication ?? 'SESSION_OR_TOKEN';
    const parameters: ApiEndpoint['parameters'] = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(match => ({ name: match[1]!, in: 'path', type: 'string', required: true, description: `${match[1]} 경로 식별자` }));
    const responses: ApiEndpoint['responses'] = [...(metadata?.responses ?? [{ status: 'default', description: '상세 응답 계약은 아직 문서화되지 않았습니다.' }])];
    if (authentication !== 'PUBLIC' && !responses.some(response => response.status === 401)) responses.push({ status: 401, description: '유효한 인증이 필요합니다.' });
    if (authentication === 'SESSION_OR_TOKEN' && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !responses.some(response => response.status === 403)) responses.push({ status: 403, description: '조회 전용 토큰으로 변경할 수 없습니다.' });
    return { id: key, method, path, group, title: metadata?.title ?? `${group} ${method} ${path}`, description: metadata?.description ?? '이 경로의 상세 요청과 응답 계약은 아직 문서화되지 않았습니다.', authentication, parameters: [...parameters.filter(p => !metadata?.parameters?.some(m => m.in === p.in && m.name === p.name)), ...(metadata?.parameters ?? [])], ...(metadata?.requestBody ? { requestBody: metadata.requestBody } : {}), responses } satisfies ApiEndpoint;
  });
  return { version: '1', generatedAtMs: Date.now(), basePath: '/api/v1', authentication: { description: '로그인 세션 또는 허용된 API 토큰을 사용합니다. 에이전트 전송에는 별도의 에이전트 토큰이 필요합니다.', bearerExample: 'Authorization: Bearer <API_TOKEN>', tokenManagement: '설정에서 OpenAPI 토큰을 발급·폐기합니다. 기본 기한은 365일입니다. READ_ONLY는 조회만, READ_WRITE는 일반 업무 API의 변경도 허용합니다. 토큰·에이전트 자격증명 관리는 로그인한 브라우저 세션이 필요합니다.' }, endpoints };
}
