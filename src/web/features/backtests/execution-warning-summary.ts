const SYMBOL = '[A-Za-z0-9._-]{1,20}';

type RepeatedWarningKind = 'cash' | 'nonTrading' | 'outsideUniverse' | 'retiredCode';

interface RepeatedWarningMatch {
  readonly kind: RepeatedWarningKind;
  readonly symbol: string;
}

const repeatedWarningPatterns: ReadonlyArray<{
  readonly kind: RepeatedWarningKind;
  readonly pattern: RegExp;
}> = [
  {
    kind: 'cash',
    pattern: new RegExp(
      `^(${SYMBOL}) 매수 거부: 현금 부족 \\(\\d{4}-\\d{2}-\\d{2}T[^)]+\\)$`,
    ),
  },
  {
    kind: 'nonTrading',
    pattern: new RegExp(
      `^(${SYMBOL}) 매수 거부: 그날 거래정지·무거래로 매수할 수 없는 종목입니다\\.$`,
    ),
  },
  {
    kind: 'outsideUniverse',
    pattern: new RegExp(
      `^(${SYMBOL}) 매수 거부: 활성 멤버십 일정에 포함되지 않은 종목입니다 \\(전략 버그 안전망\\)\\.$`,
    ),
  },
  {
    kind: 'retiredCode',
    pattern: new RegExp(
      `^(${SYMBOL}) 주문 거부/폐기: 상장폐지 경계를 넘어 재사용된 단축코드의 후속 봉에 체결할 수 없습니다\\.$`,
    ),
  },
];

const limitationPrefixes = [
  '이 백테스트가 보정하는 것:',
  '이 백테스트가 보정하지 않는 것:',
  '유동성 체결 한도:',
  '재무 데이터는 공시 시점 기준입니다.',
  '선택한 기간이 최근이라 아직 DART 에 공시되지 않은 자본변동이 있을 수 있습니다.',
  '이 실행 구간에는 거래불가일 정보가 없습니다',
] as const;

function repeatedWarning(warning: string): RepeatedWarningMatch | null {
  for (const { kind, pattern } of repeatedWarningPatterns) {
    const match = pattern.exec(warning);
    if (match?.[1] !== undefined) return { kind, symbol: match[1] };
  }
  return null;
}

function repeatedWarningSummary(
  kind: RepeatedWarningKind,
  eventCount: number,
  symbols: ReadonlySet<string>,
): string {
  switch (kind) {
    case 'cash':
      return `현금 부족으로 거부된 매수 주문 ${eventCount}건.`;
    case 'nonTrading':
      return `거래정지·무거래로 매수 거부된 종목 ${symbols.size}건.`;
    case 'outsideUniverse':
      return `활성 멤버십 일정 밖이라 매수 거부된 종목 ${symbols.size}건 (전략 버그 안전망).`;
    case 'retiredCode':
      return `상장폐지 경계를 넘어 재사용된 단축코드라 주문이 거부·폐기된 종목 ${symbols.size}건. 후속 봉에는 체결하지 않았습니다.`;
  }
}

function stripTargetSymbols(warning: string): string {
  if (!warning.startsWith('동시 보유 종목 상한(') && !warning.startsWith('유동성 체결 한도:')) {
    return warning;
  }
  return warning.replace(
    new RegExp(`— 대상 (\\d+)종목: ${SYMBOL}(?:, ${SYMBOL})*(?: 외 \\d+종목)?\\.`),
    '— 대상 $1종목.',
  );
}

function stripDelimitedSymbols(warning: string): string {
  if (
    !warning.startsWith('상장폐지로 강제 청산한 종목 ')
    && !warning.startsWith('단축코드 재사용을 발행사별로 구분할 수 없어 ')
  ) {
    return warning;
  }
  return warning.replace(
    new RegExp(`(종목 \\d+건): ${SYMBOL}(?:, ${SYMBOL})*(?: 외 \\d+종목)?\\.`),
    '$1.',
  );
}

function summarizeDatasetDrift(warning: string): string {
  const match = /^제출 이후 데이터가 변경된 종목이 있습니다: (.+) — (.+)$/.exec(warning);
  if (match?.[1] === undefined || match[2] === undefined) return warning;

  const entries = match[1].split(', ');
  const symbols = new Set<string>();
  for (const entry of entries) {
    const entryMatch = new RegExp(`^(${SYMBOL})\\([^)]+\\)$`).exec(entry);
    if (entryMatch?.[1] === undefined) return warning;
    symbols.add(entryMatch[1]);
  }
  return `제출 이후 데이터가 변경된 종목 ${symbols.size}건이 있습니다 — ${match[2]}`;
}

function summarizeOne(warning: string): string {
  return summarizeDatasetDrift(stripDelimitedSymbols(stripTargetSymbols(warning)));
}

/** 실행 결과 경고에서 종목 코드를 제거하고 반복 경고를 건수로 접는다. */
export function summarizeExecutionWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<RepeatedWarningKind, { events: number; symbols: Set<string> }>();
  for (const warning of warnings) {
    const matched = repeatedWarning(warning);
    if (matched === null) continue;
    const aggregate = counts.get(matched.kind) ?? { events: 0, symbols: new Set<string>() };
    aggregate.events += 1;
    aggregate.symbols.add(matched.symbol);
    counts.set(matched.kind, aggregate);
  }

  const emitted = new Set<RepeatedWarningKind>();
  const summaries: string[] = [];
  for (const warning of warnings) {
    const matched = repeatedWarning(warning);
    if (matched === null) {
      summaries.push(summarizeOne(warning));
      continue;
    }
    if (emitted.has(matched.kind)) continue;
    emitted.add(matched.kind);
    const aggregate = counts.get(matched.kind);
    if (aggregate !== undefined) {
      summaries.push(repeatedWarningSummary(matched.kind, aggregate.events, aggregate.symbols));
    }
  }
  return summaries;
}

/** 실행 자체의 사건보다 모델·데이터 해석 범위를 설명하는 경고인지 판별한다. */
export function isExecutionLimitation(warning: string): boolean {
  return limitationPrefixes.some((prefix) => warning.startsWith(prefix))
    || warning.includes(': 상관 그룹 워밍업 부족 ');
}
