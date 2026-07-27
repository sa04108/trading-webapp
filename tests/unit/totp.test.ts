import { describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { otpauthTotpService } from '../../src/server/modules/auth/infrastructure/otpauth-totp.js';

const PERIOD_MS = 30_000;

function tokenAt(secret: string, timestamp: number): string {
  return OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    timestamp,
  });
}

describe('otpauthTotpService.verify (window ±1 step, 스펙 §3.5)', () => {
  it('accepts the current-step token', () => {
    const secret = otpauthTotpService.generateSecret();
    const now = Date.now();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, now))).toBe(true);
  });

  it('accepts a token from one step in the future (+30s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const now = Date.now();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, now + PERIOD_MS))).toBe(true);
  });

  it('accepts a token from one step in the past (-30s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const now = Date.now();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, now - PERIOD_MS))).toBe(true);
  });

  it('rejects a token from two steps in the future (+60s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const now = Date.now();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, now + 2 * PERIOD_MS))).toBe(false);
  });

  it('rejects a token from two steps in the past (-60s)', () => {
    const secret = otpauthTotpService.generateSecret();
    const now = Date.now();
    expect(otpauthTotpService.verify(secret, tokenAt(secret, now - 2 * PERIOD_MS))).toBe(false);
  });

  it('rejects input that is not exactly 6 digits, without needing a valid secret', () => {
    const secret = otpauthTotpService.generateSecret();
    expect(otpauthTotpService.verify(secret, '12345')).toBe(false);
    expect(otpauthTotpService.verify(secret, 'abcdef')).toBe(false);
    expect(otpauthTotpService.verify(secret, '1234567')).toBe(false);
  });
});
