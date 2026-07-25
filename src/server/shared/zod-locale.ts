import { z } from 'zod';

/**
 * Zod 내장 메시지를 한국어로 (M9 의 마무리 — M9 는 손으로 쓴 메시지만 통일했다).
 * 스키마 위반이 응답에 그대로 실리는 경로(`error.issues[].message`)가 있으므로
 * 로케일을 프로세스 단위로 한 번 지정한다. 여러 번 호출해도 무해하다.
 */
export function configureZodLocale(): void {
  z.config(z.locales.ko());
}
