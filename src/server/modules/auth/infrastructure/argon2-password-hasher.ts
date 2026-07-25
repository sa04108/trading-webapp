import argon2 from 'argon2';
import type { PasswordHasher } from '../application/ports.js';

/** 스펙 §16: Argon2id. 1GB RAM 호스트를 고려해 memoryCost 는 보수적으로 설정한다. */
export const argon2PasswordHasher: PasswordHasher = {
  hash: (plain) =>
    argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19_456, // 19 MiB (OWASP 권장 프로파일)
      timeCost: 2,
      parallelism: 1,
    }),
  verify: (hash, plain) => argon2.verify(hash, plain).catch(() => false),
};
