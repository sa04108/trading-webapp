/**
 * 전략 파라미터 JSON 스키마 → 폼 스펙 변환.
 * 라벨·설명·기본값·범위는 모두 서버 스키마(zod `.meta()`, `.default()`)가 단일 소스다 —
 * 클라이언트에 사본을 두지 않는다. 위저드와 상세 페이지가 같이 쓴다.
 */
export interface NumberParamSpec {
  key: string;
  minimum?: number;
  maximum?: number;
  /** 서버 전략 스키마가 선언한 기본값 — 클라이언트 사본을 두지 않는다 */
  defaultValue?: number;
  /** 서버 스키마의 `title` — 없으면 원본 키를 라벨로 쓴다 */
  label?: string;
  /** 서버 스키마의 `description` — 툴팁 본문 */
  help?: string;
  isInteger: boolean;
  optional: boolean;
}

export function extractNumberParams(
  schema: Record<string, unknown> | undefined,
): NumberParamSpec[] {
  if (!schema) return [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(properties)
    .filter(([, def]) => def.type === 'number' || def.type === 'integer')
    .map(([key, def]) => ({
      key,
      ...(typeof def.minimum === 'number' ? { minimum: def.minimum } : {}),
      ...(typeof def.maximum === 'number' ? { maximum: def.maximum } : {}),
      ...(typeof def.default === 'number' ? { defaultValue: def.default } : {}),
      ...(typeof def.title === 'string' ? { label: def.title } : {}),
      ...(typeof def.description === 'string' ? { help: def.description } : {}),
      isInteger: def.type === 'integer',
      optional: !required.has(key),
    }));
}

/** 표시용 라벨 — 서버가 title 을 주지 않으면 원본 키로 폴백 */
export function paramLabel(spec: NumberParamSpec): string {
  return spec.label ?? spec.key;
}

/** 툴팁 하단 메타 줄: `원본키 · 범위 · 기본값` */
export function paramMetaLine(spec: NumberParamSpec): string {
  const parts = [spec.key];
  if (spec.minimum !== undefined && spec.maximum !== undefined) {
    parts.push(`${spec.minimum}~${spec.maximum}`);
  } else if (spec.minimum !== undefined) {
    parts.push(`${spec.minimum} 이상`);
  } else if (spec.maximum !== undefined) {
    parts.push(`${spec.maximum} 이하`);
  }
  if (spec.defaultValue !== undefined) parts.push(`기본 ${spec.defaultValue}`);
  else if (spec.optional) parts.push('선택 입력');
  return parts.join(' · ');
}
