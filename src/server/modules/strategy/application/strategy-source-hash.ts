import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnyTradingStrategy } from '../domain/strategy.js';

/** 해시에서 제외하는 표시용 필드 — 값 검증에 영향이 없다 */
const PRESENTATION_KEYS = new Set(['title', 'description']);

/**
 * JSON 스키마에서 표시용 필드(`title`/`description`)를 재귀 제거한다.
 * 남은 키의 순서는 원본 삽입 순서를 그대로 유지한다 — meta 를 붙이기 전과
 * 바이트 단위로 같은 JSON 이 나와야 과거 실행의 해시와 계속 비교된다.
 */
function stripPresentation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPresentation);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRESENTATION_KEYS.has(key)) continue;
    result[key] = stripPresentation(child);
  }
  return result;
}

/**
 * 재현성 메타데이터용 전략 소스 해시 (스펙 §9.5).
 * 빌드 산출물에서 원본 소스를 읽을 수 없어 id + version + 파라미터 스키마의 해시로
 * 대체한다 (전략 로직을 바꿀 때는 version 을 올릴 것).
 *
 * 파라미터의 한국어 라벨·설명은 해시에 넣지 않는다 — 문구만 다듬어도 과거 실행이
 * "다른 전략" 으로 보이면 비교가 끊긴다.
 */
export function strategySourceHash(strategy: AnyTradingStrategy): string {
  const schema = z.toJSONSchema(strategy.parameterSchema as z.ZodType);
  return createHash('sha256')
    .update(strategy.id)
    .update(strategy.version)
    .update(JSON.stringify(stripPresentation(schema)))
    .digest('hex');
}
