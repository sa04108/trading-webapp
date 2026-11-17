import { z } from 'zod';
import { configurationSearchPreviewSchema } from '../../../../shared/schemas/configuration-search.js';
import type { ApiReferenceMetadata } from './api-reference.js';

const searchValue = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
const nullableString = { type: ['string', 'null'] };
const catalogField = { type: 'object', required: ['key', 'label', 'group', 'kind', 'current'], properties: {
  key: { type: 'string', description: 'settings에서 사용하는 경로' }, label: { type: 'string' }, group: { enum: ['strategy', 'universe', 'execution', 'seed'] }, kind: { enum: ['number', 'choice'] }, current: searchValue,
  description: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, integer: { type: 'boolean' }, allowUnset: { type: 'boolean' }, recommended: { type: 'array', items: searchValue }, options: { type: 'array', items: { type: 'object', required: ['value', 'label'], properties: { value: searchValue, label: { type: 'string' } } } },
} };
const catalog = { type: 'object', required: ['mode', 'sourceJobId', 'strategyId', 'strategyName', 'period', 'maxCount', 'fields'], properties: {
  mode: { enum: ['daily', 'intraday'] }, sourceJobId: { type: 'string' }, strategyId: { type: 'string' }, strategyName: { type: 'string' }, period: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } }, required: ['from', 'to'] }, maxCount: { type: 'integer', const: 100 }, fields: { type: 'array', items: catalogField },
} };
const metric = { type: ['object', 'null'], properties: { totalReturnPct: { type: 'number' }, mddPct: { type: 'number' }, sharpeRatio: { type: ['number', 'null'] } }, required: ['totalReturnPct', 'mddPct', 'sharpeRatio'] };
const item = { type: 'object', required: ['id', 'ordinal', 'status', 'values', 'request', 'jobId', 'resultHref', 'error', 'metrics'], properties: {
  id: { type: 'string' }, ordinal: { type: 'integer', minimum: 0 }, status: { enum: ['PENDING', 'PREPARING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] }, values: { type: 'object', additionalProperties: searchValue, description: '탐색한 키와 실제 샘플 값' }, request: { type: 'object', description: '자식 일봉 또는 분봉 백테스트 전체 설정' }, jobId: nullableString, resultHref: nullableString, error: nullableString, metrics: metric,
} };
const summaryProperties = { id: { type: 'string' }, sourceJobId: { type: 'string' }, mode: { enum: ['daily', 'intraday'] }, strategyId: { type: 'string' }, strategyName: { type: 'string' }, period: catalog.properties.period, config: (z.toJSONSchema(configurationSearchPreviewSchema, { io: 'input' }) as { properties: Record<string, unknown> }).properties.config, status: { enum: ['PREVIEW', 'ACTIVE', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED'] }, totalCount: { type: 'integer' }, completedCount: { type: 'integer' }, failedCount: { type: 'integer' }, pendingCount: { type: 'integer' }, runningCount: { type: 'integer' }, createdAtMs: { type: 'integer' }, completedAtMs: { type: ['integer', 'null'] }, error: nullableString, sourceHref: { type: 'string' } };
const summary = { type: 'object', required: Object.keys(summaryProperties), properties: summaryProperties };
const detail = { type: 'object', required: [...Object.keys(summaryProperties), 'catalog', 'items'], properties: { ...summaryProperties, catalog, items: { type: 'array', items: item } } };
const wrapper = (key: string, value: unknown) => ({ type: 'object', required: [key], properties: { [key]: value } });
const errors = [{ status: 400, description: '요청 형식 오류.', contentType: 'application/json' }, { status: 404, description: '소유한 원본이나 실험이 없습니다.', contentType: 'application/json' }, { status: 409, description: '요청 ID 충돌, 실행 기준 변경 또는 실행 한도.', contentType: 'application/json' }, { status: 422, description: '탐색 범위 또는 유효 조합 부족.', contentType: 'application/json' }];
const response = (status: number, description: string, result: Record<string, unknown>) => [{ status, description, contentType: 'application/json', schema: result }, ...errors];
const previewSchema = z.toJSONSchema(configurationSearchPreviewSchema, { io: 'input' }) as Record<string, unknown>;
export const searchApiMetadata: Record<string, ApiReferenceMetadata> = {};
for (const base of ['/api/v1/backtests/:id/configuration-search', '/api/v1/intraday/runs/:id/configuration-search']) {
  searchApiMetadata[`GET ${base}/catalog`] = { title: '설정 탐색 카탈로그', description: '원본별 탐색 키, 현재값, 허용 범위와 선택지를 반환합니다.', responses: response(200, 'catalog 객체.', wrapper('catalog', catalog)) };
  searchApiMetadata[`GET ${base}`] = { title: '설정 탐색 목록', description: '원본의 저장된 미리보기와 실행한 실험을 반환합니다.', responses: response(200, 'experiments 요약 배열.', wrapper('experiments', { type: 'array', items: summary })) };
  searchApiMetadata[`POST ${base}/preview`] = { title: '설정 탐색 미리보기', description: '실행하지 않고 샘플 조합을 영속 저장합니다. 같은 requestId와 본문은 같은 조합을 반환합니다.', requestBody: { contentType: 'application/json', description: 'catalog에서 선택한 설정과 1~100개 조합 수를 지정합니다. 생략한 설정은 원본 그대로 고정됩니다.', schema: previewSchema, example: { requestId: '123e4567-e89b-42d3-a456-426614174000', config: { count: 2, settings: base.includes('/intraday/') ? { 'parameters.fast': { kind: 'RANGE', min: 2, max: 3 } } : { 'parameters.lookbackBars': { kind: 'RANGE', min: 10, max: 11 } } } } }, responses: response(201, 'experiment 상세와 실제 샘플 items.', wrapper('experiment', detail)) };
}
for (const [method, suffix, title, status, description] of [
  ['GET', '', '설정 탐색 상세', 200, '저장된 실험과 샘플 설정, 상태 및 결과 링크를 반환합니다.'],
  ['POST', '/start', '설정 탐색 시작', 202, '저장된 조합을 시작합니다. 반복 요청은 같은 실험을 반환합니다.'],
  ['POST', '/cancel', '설정 탐색 취소', 200, '대기와 실행 중 자식의 취소를 요청합니다.'],
] as const) searchApiMetadata[`${method} /api/v1/configuration-searches/:id${suffix}`] = { title, description, responses: response(status, 'experiment 상세 객체.', wrapper('experiment', detail)) };
searchApiMetadata['DELETE /api/v1/configuration-searches/:id'] = { title: '설정 탐색 삭제', description: '미시작 또는 종료된 실험과 자식 결과를 삭제합니다.', responses: [{ status: 204, description: '실험 및 자식 결과 삭제 완료.' }, ...errors] };
