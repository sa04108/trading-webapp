import * as OTPAuth from 'otpauth';
import type { TotpService } from '../application/ports.js';

const ISSUER = 'Quant Platform';
const DIGITS = 6;
const PERIOD_SEC = 30;

/**
 * base32 가 아닌 secret 은 `Secret.fromBase32` 가 던진다 — 부분 기록·수기 DB 편집·
 * 향후 마이그레이션 버그로 손상된 행이 500(스택 노출)이 되지 않게 여기서 닫는다.
 * 인증 경로의 예외는 언제나 "거부" 로 접혀야지 "오류" 로 새면 안 된다.
 */
function parseSecret(secret: string): OTPAuth.Secret | null {
  try {
    return OTPAuth.Secret.fromBase32(secret);
  } catch {
    return null;
  }
}

export const otpauthTotpService: TotpService = {
  generateSecret(): string {
    return new OTPAuth.Secret({ size: 20 }).base32;
  },

  buildUri(secret: string, username: string): string {
    const parsed = parseSecret(secret);
    if (!parsed) throw new Error('TOTP secret 이 올바른 base32 가 아닙니다');
    return new OTPAuth.TOTP({
      issuer: ISSUER,
      label: username,
      secret: parsed,
      digits: DIGITS,
      period: PERIOD_SEC,
    }).toString();
  },

  verify(secret: string, token: string, nowMs?: number): number | null {
    if (!/^\d{6}$/.test(token)) return null;
    const parsed = parseSecret(secret);
    if (!parsed) return null;

    const timestamp = nowMs ?? Date.now();
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      secret: parsed,
      digits: DIGITS,
      period: PERIOD_SEC,
    });
    // window 1: 시계 오차 ±30초 허용
    const delta = totp.validate({ token, timestamp, window: 1 });
    if (delta === null) return null;
    // 맞은 코드가 속한 절대 타임스텝. 호출자가 이 값으로 재사용을 차단한다.
    return Math.floor(timestamp / 1000 / PERIOD_SEC) + delta;
  },
};
