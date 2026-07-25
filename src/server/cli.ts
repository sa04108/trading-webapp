/**
 * 서버 CLI (스펙 §16): 관리자 생성은 CLI 에서만 가능하다.
 *
 *   node dist/server/cli.js admin:create
 *   pnpm cli admin:create
 */
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig } from './bootstrap/config.js';
import { createContainer } from './bootstrap/container.js';
import { sha256Hex } from './modules/auth/application/auth-service.js';
import { newId } from './shared/ids.js';

function ask(question: string, hidden = false): Promise<string> {
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: hidden ? muted : process.stdout,
    terminal: true,
  });
  if (hidden) process.stdout.write(question);
  return new Promise((resolve) => {
    rl.question(hidden ? '' : question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function adminCreate(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);
  try {
    const username = await ask('사용자 이름: ');
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      throw new Error('사용자 이름은 3~32자의 영문/숫자/_/- 만 허용합니다.');
    }
    if (username === 'admin') {
      console.warn('경고: 추측하기 쉬운 사용자 이름입니다. 다른 이름을 권장합니다.');
    }
    if (container.userRepository.findByUsername(username)) {
      throw new Error('이미 존재하는 사용자입니다.');
    }

    const password = await ask('비밀번호 (14자 이상): ', true);
    if (password.length < 14) {
      throw new Error('비밀번호는 최소 14자여야 합니다. (스펙 §16)');
    }
    const confirm = await ask('비밀번호 확인: ', true);
    if (password !== confirm) {
      throw new Error('비밀번호가 일치하지 않습니다.');
    }

    const passwordHash = await container.passwordHasher.hash(password);
    const totpSecret = container.totpService.generateSecret();
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));

    container.userRepository.create(
      {
        id: newId('usr'),
        username,
        passwordHash,
        totpSecret,
        totpEnabled: true,
        recoveryCodeHashes: recoveryCodes.map(sha256Hex),
      },
      container.clock.now(),
    );
    container.auditLog.record(username, 'auth.admin.created');

    console.log('\n관리자 계정이 생성되었습니다.\n');
    console.log('1) 인증 앱(Google Authenticator 등)에 아래 URI 또는 secret 을 등록하세요:');
    console.log(`   otpauth URI: ${container.totpService.buildUri(totpSecret, username)}`);
    console.log(`   TOTP secret (base32): ${totpSecret}`);
    console.log('\n2) 복구 코드를 안전한 곳에 보관하세요 (각 1회용, 재표시 불가):');
    for (const code of recoveryCodes) console.log(`   ${code}`);
    console.log('\n이 정보는 다시 표시되지 않습니다. (스펙 §16 TOTP secret 재노출 금지)');
  } finally {
    container.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case 'admin:create':
      await adminCreate();
      break;
    default:
      console.log('사용법: cli <command>');
      console.log('  admin:create   관리자 계정 생성');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
