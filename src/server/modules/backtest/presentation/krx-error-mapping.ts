import type { FastifyReply } from 'fastify';
import { KrxNotConfiguredError, KrxQuotaError } from '../../market-data/application/ports.js';
import { SymbolMasterNotCoveredError } from '../../market-data/application/symbol-master-service.js';

/**
 * `UniverseRuleResolver.resolve` (제출 검증·미리보기 공용)는 시총 캐시 미스일 때 KRX 를
 * 부른다 — `symbol-master-routes.ts` 의 `/symbol-master/sync`·`/backfill` 과 같은
 * 호출부다. 같은 관례로 매핑한다: 쿼터 초과는 429(사용자가 기다리면 되는 문제), 미설정은
 * 503(운영이 키를 넣어야 하는 문제). 나머지 오류(분류 불가 등)는 처리하지 않고 그대로
 * 위로 던져 기본 오류 처리기(500)가 받게 한다.
 */
export function sendIfKrxError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof KrxQuotaError) {
    reply.code(429).send({ error: error.message });
    return true;
  }
  if (error instanceof KrxNotConfiguredError) {
    reply.code(503).send({ error: error.message });
    return true;
  }
  return false;
}

/**
 * SymbolMasterNotCoveredError 는 종목 마스터가 그 날짜의 coverage·거래일 anchor를
 * 갖지 못했다는 뜻이다 — 클라이언트가 먼저 동기화해야 하는 409 상황이지 서버 결함(500)이
 * 아니다. sendIfKrxError 와 나란히 둔다: 두 오류 모두 "지금은 KRX/마스터 상태가 준비되지
 * 않았다"는 같은 층위의 신호라 호출부에서 순서를 가리지 않고 둘 다 확인하면 된다.
 */
export function sendIfNotCovered(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof SymbolMasterNotCoveredError) {
    reply.code(409).send({ error: error.message });
    return true;
  }
  return false;
}
