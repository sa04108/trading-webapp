import { ulid } from 'ulid';

/** `bt_01J...` 형태의 접두사 ULID (스펙 §34 예시 형식) */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
