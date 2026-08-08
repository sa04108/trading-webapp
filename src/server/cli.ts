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
import type { FactIngestionGap } from './modules/facts/application/ports.js';

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
    container.close();
  }
}

/**
 * gap 사유 문구에서 값이 섞이기 전 앞부분만 묶는 키로 쓴다(':' 나 '(' 앞까지) — 같은
 * 실패 유형이 종목마다 다른 값을 물고 나와도 하나로 묶여 세어지도록 한다.
 */
function reasonBucket(reason: string): string {
  const cutCandidates = [reason.indexOf(':'), reason.indexOf('(')].filter((index) => index >= 0);
  const cut = cutCandidates.length > 0 ? Math.min(...cutCandidates) : reason.length;
  return reason.slice(0, cut).trim();
}

/** 인자 파싱: --symbols 005930,000660 --from 2015 --to 2026 [--fs-div OFS] */
function parseFactsSyncArgs(argv: readonly string[]): {
  symbols: readonly string[];
  fromYear: number;
  toYear: number;
  consolidated: boolean;
} {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }

  const symbolsRaw = flags.get('symbols');
  if (!symbolsRaw) throw new Error('--symbols <종목코드,종목코드,...> 가 필요합니다');
  const symbols = symbolsRaw
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  if (symbols.length === 0) throw new Error('--symbols 가 비어 있습니다');

  const fromYear = Number(flags.get('from'));
  const toYear = Number(flags.get('to'));
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    throw new Error('--from <연도> --to <연도> 를 올바르게 지정하세요 (예: --from 2015 --to 2026)');
  }

  const fsDiv = (flags.get('fs-div') ?? 'CFS').toUpperCase();
  if (fsDiv !== 'CFS' && fsDiv !== 'OFS') {
    throw new Error('--fs-div 는 CFS(연결) 또는 OFS(별도) 입니다');
  }

  return { symbols, fromYear, toYear, consolidated: fsDiv === 'CFS' };
}

async function factsSync(argv: readonly string[]): Promise<void> {
  const { symbols, fromYear, toYear, consolidated } = parseFactsSyncArgs(argv);
  const config = loadConfig();
  if (!config.dartApiKey) {
    throw new Error('DART_API_KEY 가 설정되지 않았습니다. .env 에 추가한 뒤 다시 실행하세요.');
  }

  const container = createContainer(config);
  try {
    // 컨테이너는 `database: DatabaseHandle` 을 노출한다 — Drizzle 인스턴스는 그 안의 `.db` 다
    // 종목이 데이터 소관이다(설계 2026-07-31-symbol-as-first-class) — 데이터셋 개념이
    // 사라지면서(스펙 2026-08-05, Task 6) 이 명령도 종목 코드를 직접 받는다.
    const registered = new Set(
      container.symbolService.listSymbols().map((symbol) => symbol.code),
    );
    const missing = symbols.filter((code) => !registered.has(code));
    if (missing.length > 0) {
      throw new Error(`등록되지 않은 종목입니다: ${missing.join(', ')}`);
    }
    const foreign = container.symbolService
      .listSymbols()
      .filter((symbol) => symbols.includes(symbol.code) && symbol.market !== 'KR');
    if (foreign.length > 0) {
      throw new Error(
        `DART 수집은 KR 종목만 지원합니다 — ${foreign.map((s) => s.code).join(', ')}`,
      );
    }
    console.log(
      `${symbols.length}종목, ${fromYear}~${toYear}년, ` +
        `${consolidated ? '연결(CFS)' : '별도(OFS)'} 기준으로 수집합니다.`,
    );

    // 40분 넘게 걸리는 실행이라 진행 상황을 종목마다 찍는다 — 조용한 40분은 멈춘 것과
    // 구분되지 않는다. 팩트 저장도 종목 단위이므로 이 줄이 곧 "여기까지는 남는다" 다.
    const report = await container.factSyncService.sync(
      // CLI 는 지정한 구간을 전부 다시 받는다 — 과거 연도 정정공시 재수집이
      // 이 명령의 역할이다 (웹은 증분)
      { symbols, fromYear, toYear, consolidated, mode: 'FULL' },
      {
        onSymbolDone: ({ symbol, index, total, savedFacts, gapCount }) => {
          console.log(
            `  [${index}/${total}] ${symbol}: 팩트 ${savedFacts}건 저장` +
              (gapCount > 0 ? `, 누락 ${gapCount}건` : ''),
          );
        },
      },
    );

    console.log(`\n저장된 팩트: ${report.savedFacts}건`);
    // 중단은 조용히 넘기지 않는다 — "어디까지 갔는지" 를 모르면 운영자는 처음부터 다시
    // 돌릴 수밖에 없다. 누락 리포트는 그대로 이어서 찍는다.
    if (report.failureMessage !== null) {
      console.error(`\n${report.failureMessage}`);
      process.exitCode = 1;
    }
    if (report.savedFacts === 0 && report.gaps.length === 0 && report.failureMessage === null) {
      // 저장된 것도 누락도 0건이면 "성공적으로 아무것도 안 함" 처럼 읽히는 결과다 —
      // 대개는 수집 범위·API 키·종목 목록이 잘못됐다는 신호이므로 경고한다
      console.warn(
        '경고: 저장된 팩트도 누락도 0건입니다. 수집 범위(연도·종목)나 DART 응답을 확인하세요 ' +
          '— 수집이 조용히 아무 일도 하지 않았을 수 있습니다.',
      );
      return;
    }
    if (report.gaps.length === 0) {
      console.log('누락 없음.');
      return;
    }
    // 누락을 조용히 넘기면 랭킹이 소리 없이 왜곡된다 — 전부 보여준다.
    // 단순히 앞의 50건만 보여주면 종목 수가 많은 백필에서 첫 종목의 실패만 보이고
    // 나머지 199개 종목의 서로 다른 실패 유형은 가려진다 — 사유별로 묶어 개수부터 보여준다.
    console.log(`\n누락 ${report.gaps.length}건:`);
    const buckets = new Map<string, FactIngestionGap[]>();
    for (const gap of report.gaps) {
      const bucket = reasonBucket(gap.reason);
      const list = buckets.get(bucket) ?? [];
      list.push(gap);
      buckets.set(bucket, list);
    }
    const EXAMPLES_PER_REASON = 5;
    const sortedBuckets = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [bucket, gaps] of sortedBuckets) {
      console.log(`  [${gaps.length}건] ${bucket}`);
      for (const gap of gaps.slice(0, EXAMPLES_PER_REASON)) {
        console.log(`    - ${gap.symbol} ${gap.periodKey}: ${gap.reason}`);
      }
      if (gaps.length > EXAMPLES_PER_REASON) {
        console.log(`    ... 그 외 ${gaps.length - EXAMPLES_PER_REASON}건 (같은 사유)`);
      }
    }
  } finally {
    container.close();
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
    case 'facts:sync':
      await factsSync(process.argv.slice(3));
      break;
    case 'krx:backfill-non-trading':
      await krxBackfillNonTrading(process.argv.slice(3));
      break;
    default:
      console.log('사용법: cli <command>');
      console.log('  admin:create   관리자 계정 생성');
      console.log('  totp:enroll    TOTP 2단계 인증 등록·재발급 (CLI 전용)');
      console.log('  facts:sync     DART 재무·자본변동 수집 (--symbols <코드,코드,...> --from <연도> --to <연도> [--fs-div CFS|OFS])');
      console.log('  krx:backfill-non-trading  이미 수집한 구간의 거래불가일 채우기 (--from <날짜> --to <날짜>)');
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
