import { describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { otpauthTotpService } from '../../src/server/modules/auth/infrastructure/otpauth-totp.js';

const PERIOD_MS = 30_000;

/**
 * 스텝 경계에 딱 붙지 않는 고정 시각을 쓴다. 실제 시계를 읽으면 테스트가 토큰을
 * 만든 순간과 verify 가 시각을 읽는 순간이 30초 경계를 사이에 두고 갈릴 수 있어
 * ±1 스텝 경계 검사가 간헐적으로 깨진다 — 그래서 verify 가 nowMs 를 받는다.
 */
const NOW = 1_700_000_015_000; // 스텝 중앙 부근 (…015초)

function tokenAt(secret: string, timestamp: number): string {
  return OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    timestamp,
  });
}

describe('otpauthTotpService.verify (window ±1 step, 스펙 §3.5)', () => {
  it('accepts the current-step token and returns its step', () => {
    const secret = otpauthTotpService.generateSecret();
    const step = otpauthTotpService.verify(secret, tokenAt(secret, NOW), NOW);
    expect(step).toBe(Math.floor(NOW / 1000 / 30));
  });

  it('accepts a token from one step in the future (+30s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const step = otpauthTotpService.verify(secret, tokenAt(secret, NOW + PERIOD_MS), NOW);
    expect(step).toBe(Math.floor(NOW / 1000 / 30) + 1);
  });

  it('accepts a token from one step in the past (-30s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const step = otpauthTotpService.verify(secret, tokenAt(secret, NOW - PERIOD_MS), NOW);
    expect(step).toBe(Math.floor(NOW / 1000 / 30) - 1);
  });

  it('rejects a token from two steps in the future (+60s)', () => {
    const secret = otpauthTotpService.generateSecret();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, NOW + 2 * PERIOD_MS), NOW)).toBeNull();
  });

  it('rejects a token from two steps in the past (-60s)', () => {
    const secret = otpauthTotpService.generateSecret();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, NOW - 2 * PERIOD_MS), NOW)).toBeNull();
  });

  it('gives distinct steps to adjacent time windows — 재사용 차단의 전제', () => {
    const secret = otpauthTotpService.generateSecret();
    const first = otpauthTotpService.verify(secret, tokenAt(secret, NOW), NOW);
    const next = otpauthTotpService.verify(
      secret,
      tokenAt(secret, NOW + PERIOD_MS),
      NOW + PERIOD_MS,
    );
    expect(first).not.toBeNull();
    expect(next).toBe((first ?? 0) + 1);
  });

  it('rejects input that is not exactly 6 digits, without needing a valid secret', () => {
    const secret = otpauthTotpService.generateSecret();
    expect(otpauthTotpService.verify(secret, '12345')).toBeNull();
    expect(otpauthTotpService.verify(secret, 'abcdef')).toBeNull();
    expect(otpauthTotpService.verify(secret, '1234567')).toBeNull();
  });

  it('fails closed on a corrupted secret instead of throwing', () => {
    // 부분 기록·수기 편집으로 base32 가 아닌 값이 들어와도 500 이 아니라 거부여야 한다
    expect(otpauthTotpService.verify('not-base32!', '123456')).toBeNull();
    expect(() => otpauthTotpService.buildUri('not-base32!', 'operator')).toThrow();
  });
});
