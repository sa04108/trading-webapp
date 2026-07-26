/**
 * 서버 CLI (스펙 §16): 관리자 생성은 CLI 에서만 가능하다.
 *
 *   node dist/server/cli.js admin:create
 *   pnpm cli admin:create
 */
import readline from 'node:readline';
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
      { id: newId('usr'), username, passwordHash },
      container.clock.now(),
    );
    container.auditLog.record(username, 'auth.admin.created');

    console.log(`\n관리자 계정 '${username}' 이 생성되었습니다.`);
    console.log('로그인은 사용자 이름과 비밀번호만으로 합니다. (D-014)');
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
