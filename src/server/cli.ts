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

/**
 * DB 를 새 릴리스가 기대하는 상태로 올려 둔다 — 스키마 마이그레이션과 데이터
 * 마이그레이션을 전부 포함한다.
 *
 * 하는 일이 "컨테이너를 한 번 만들고 닫는다" 인 이유: 스키마 마이그레이션은
 * `openDatabase` 가, 데이터 마이그레이션은 각 서비스 생성자가 이미 돌린다
 * (`SymbolMasterService` 의 SCD 이행 등). 컨테이너 조립이 그 둘을 모두 태우므로
 * 마이그레이션 목록을 여기에 따로 두지 않는다. 앞으로 같은 패턴의 데이터
 * 마이그레이션이 늘어도 이 명령은 손대지 않아도 된다.
 *
 * 배포가 서비스를 멈춘 창에서 이걸 먼저 부른다. 그러지 않으면 부팅 안에서
 * 마이그레이션이 돌아 포트가 늦게 열리고, 무거운 데이터 마이그레이션 한 번에
 * readiness 확인이 타임아웃한다 — 2026-08-09 배포 장애가 그 경로였다
 * (SCD 이행 16초, readiness 창 18초).
 */
async function dbPrepare(): Promise<void> {
  const config = loadConfig();
  const startedAtMs = Date.now();
  const container = createContainer(config);
  try {
    console.log(`DB 준비 완료 (${Date.now() - startedAtMs}ms): ${config.databasePath}`);
  } finally {
    await container.close();
  }
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
      throw new Error('비밀번호는 최소 14자여야 합니다.');
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
        totpLastUsedStep: null,
        recoveryCodeHashes: [],
      },
      container.clock.now(),
    );
    container.auditLog.record(username, 'auth.admin.created');

    console.log(`\n관리자 계정 '${username}' 이 생성되었습니다.`);
    console.log('다음: pnpm cli totp:enroll 로 TOTP 를 등록하세요 — 외부에 공개하기 전 필수입니다.');
  } finally {
    await container.close();
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

    console.log('\n1) 인증 앱(Google Authenticator 등)에 아래 URI 또는 secret 을 등록하세요:');
    console.log(`   otpauth URI: ${container.totpService.buildUri(secret, username)}`);
    console.log(`   TOTP secret (base32): ${secret}`);

    // 확인 코드를 받기 전에는 아무것도 저장하지 않는다. 먼저 totp_enabled 를 켜면
    // QR 오독·시계 어긋남으로 등록이 어긋났을 때 secret 은 재노출 금지(§16)이고
    // 웹 재등록 경로도 없어서(설계 §3.3), 만들 수 없는 코드를 영원히 요구받게 된다.
    console.log('\n2) 등록이 됐는지 확인합니다 — 인증 앱에 표시된 6자리 코드를 입력하세요.');
    let confirmed = false;
    for (let attempt = 1; attempt <= 3 && !confirmed; attempt += 1) {
      const code = await ask(`   확인 코드 (${attempt}/3): `);
      if (container.totpService.verify(secret, code, container.clock.now()) !== null) {
        confirmed = true;
      } else if (attempt < 3) {
        console.log('   코드가 맞지 않습니다. 서버와 기기의 시각이 맞는지도 확인하세요.');
      }
    }
    if (!confirmed) {
      throw new Error('확인 코드를 검증하지 못했습니다 — 아무것도 변경하지 않았습니다.');
    }

    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    const recoveryCodeHashes: string[] = [];
    for (const code of recoveryCodes) {
      recoveryCodeHashes.push(await container.passwordHasher.hash(code));
    }

    container.userRepository.setTotp(user.id, secret, recoveryCodeHashes, container.clock.now());
    container.auditLog.record(username, 'auth.totp.enrolled');

    console.log('\nTOTP 가 등록되었습니다.\n');
    console.log('3) 복구 코드를 안전한 곳에 보관하세요 (각 1회용, 재표시 불가):');
    for (const code of recoveryCodes) console.log(`   ${code}`);
    console.log('\n이 정보는 다시 표시되지 않습니다.');
  } finally {
    await container.close();
  }
}

/**
 * 이미 수집한 구간의 거래불가일을 뒤늦게 채운다 — `ingestDate` 를 다시 부르지 않으므로
 * 이벤트·coverage·봉을 건드릴 위험이 없다 (SymbolMasterService.backfillNonTradingDays 참고).
 */
async function krxBackfillNonTrading(argv: readonly string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }
  const from = flags.get('from');
  const to = flags.get('to');
  if (!from || !to) {
    console.error('사용법: cli krx:backfill-non-trading --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const container = createContainer(config);
  try {
    const result = await container.symbolMasterService.backfillNonTradingDays(from, to);
    console.log(`거래일 ${result.dates}일에서 거래불가 ${result.rows}건을 기록했습니다.`);
    // 커버가 안 남았으면 다음 백테스트 경고가 여전히 "정보가 없습니다" 다 — 그 이유를 여기서 밝힌다
    if (result.dates === 0) {
      console.error(
        '한 날짜도 응답을 받지 못해 이 구간을 수집 완료로 기록하지 않았습니다. '
          + 'KRX 키·기간 설정을 확인한 뒤 다시 실행하세요.',
      );
      process.exitCode = 1;
    }
  } finally {
    await container.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case 'db:prepare':
      await dbPrepare();
      break;
    case 'admin:create':
      await adminCreate();
      break;
    case 'totp:enroll':
      await totpEnroll();
      break;
    case 'krx:backfill-non-trading':
      await krxBackfillNonTrading(process.argv.slice(3));
      break;
    default:
      // 재무·자본변동 수집은 더 이상 CLI 명령이 아니다 — 백테스트 준비(preparation)가
      // 필요한 구간만 자동으로 수집한다(스펙 2026-08-09, D-049). 여기서 옛 `facts:sync`
      // 를 명시적으로 "지원하지 않는 명령"이라 밝히는 이유: 사용법에서만 지우면 그
      // 명령을 그대로 치는 운영 스크립트·습관이 조용히 아무 일도 안 하는 성공으로
      // 읽힐 수 있다.
      if (command) {
        console.error(`지원하지 않는 명령입니다: ${command}`);
      }
      console.log('사용법: cli <command>');
      console.log('  db:prepare     스키마·데이터 마이그레이션 적용 (서비스 기동 전에 실행)');
      console.log('  admin:create   관리자 계정 생성');
      console.log('  totp:enroll    TOTP 2단계 인증 등록·재발급 (CLI 전용)');
      console.log('  krx:backfill-non-trading  이미 수집한 구간의 거래불가일 채우기 (--from <날짜> --to <날짜>)');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
