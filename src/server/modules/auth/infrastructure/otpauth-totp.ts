import * as OTPAuth from 'otpauth';
import type { TotpService } from '../application/ports.js';

const ISSUER = 'Quant Platform';

export const otpauthTotpService: TotpService = {
  generateSecret(): string {
    return new OTPAuth.Secret({ size: 20 }).base32;
  },

  buildUri(secret: string, username: string): string {
    return new OTPAuth.TOTP({
      issuer: ISSUER,
      label: username,
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    }).toString();
  },

  verify(secret: string, token: string): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    });
    // window 1: 시계 오차 ±30초 허용
    return totp.validate({ token, window: 1 }) !== null;
  },
};
