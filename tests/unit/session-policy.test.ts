import { describe, expect, it } from 'vitest';
import {
  isLoginLocked,
  isSessionExpired,
} from '../../src/server/modules/auth/domain/session-policy.js';

const POLICY = { idleTimeoutMs: 43_200_000, absoluteTimeoutMs: 604_800_000 };

describe('isSessionExpired (스펙 §16)', () => {
  it('keeps a fresh session alive', () => {
    const session = { createdAtMs: 0, lastSeenAtMs: 0 };
    expect(isSessionExpired(session, 1_000, POLICY)).toBe(false);
  });

  it('expires after idle timeout (12h)', () => {
    const session = { createdAtMs: 0, lastSeenAtMs: 0 };
    expect(isSessionExpired(session, POLICY.idleTimeoutMs + 1, POLICY)).toBe(true);
  });

  it('expires after absolute timeout (7d) even if recently active', () => {
    const now = POLICY.absoluteTimeoutMs + 1;
    const session = { createdAtMs: 0, lastSeenAtMs: now - 1_000 };
    expect(isSessionExpired(session, now, POLICY)).toBe(true);
  });
});

describe('isLoginLocked', () => {
  it('locks at the failure limit', () => {
    expect(isLoginLocked(4, 5)).toBe(false);
    expect(isLoginLocked(5, 5)).toBe(true);
  });
});
