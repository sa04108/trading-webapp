/**
 * 서버 CLI (스펙 §16): 관리자 생성은 CLI 에서만 가능하다.
 *
 *   node dist/server/cli.js admin:create
 *   pnpm cli admin:create
 */
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { loadConfig } from './bootstrap/config.js';
import { createContainer } from './bootstrap/container.js';
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

    container.userRepository.create(
      {
        id: newId('usr'),
        username,
        passwordHash,
        totpSecret: null,
        totpEnabled: false,
        recoveryCodeHashes: [],
      },
      container.clock.now(),
    );
    container.auditLog.record(username, 'auth.admin.created');

    console.log(`\n관리자 계정 '${username}' 이 생성되었습니다.`);
    console.log('다음: pnpm cli totp:enroll 로 TOTP 를 등록하세요 — 퍼블릭 노출 전 필수 (설계 §3.4)');
  } finally {
    container.close();
  }
}

async function totpEnroll(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);
  try {
    const username = await ask('사용자 이름: ');
    const user = container.userRepository.findByUsername(username);
    if (!user) throw new Error('존재하지 않는 사용자입니다.');
    if (user.totpEnabled) {
      const answer = await ask(
        '이미 TOTP 가 등록되어 있습니다. 재발급하면 기존 인증 앱 항목과 복구 코드가 전부 무효화됩니다. 계속하려면 yes: ',
      );
      if (answer !== 'yes') {
        console.log('중단했습니다.');
        return;
      }
    }

    const secret = container.totpService.generateSecret();
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    const recoveryCodeHashes: string[] = [];
    for (const code of recoveryCodes) {
      recoveryCodeHashes.push(await container.passwordHasher.hash(code));
    }

    container.userRepository.setTotp(user.id, secret, recoveryCodeHashes, container.clock.now());
    container.auditLog.record(username, 'auth.totp.enrolled');

    console.log('\nTOTP 가 등록되었습니다.\n');
    console.log('1) 인증 앱(Google Authenticator 등)에 아래 URI 또는 secret 을 등록하세요:');
    console.log(`   otpauth URI: ${container.totpService.buildUri(secret, username)}`);
    console.log(`   TOTP secret (base32): ${secret}`);
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
    case 'totp:enroll':
      await totpEnroll();
      break;
    default:
      console.log('사용법: cli <command>');
      console.log('  admin:create   관리자 계정 생성');
      console.log('  totp:enroll    TOTP 2단계 인증 등록·재발급 (CLI 전용, 스펙 §16)');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
