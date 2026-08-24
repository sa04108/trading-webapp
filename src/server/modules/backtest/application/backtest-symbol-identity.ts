import { createHash } from 'node:crypto';
import type {
  KnownRegisteredSymbolIdentity,
  SymbolMasterService,
} from '../../market-data/application/symbol-master-service.js';
import type {
  SymbolIdentityConflict,
  SymbolIdentityInferenceConflict,
  SymbolIdentityPair,
  SymbolIdentitySelection,
} from '../../market-data/domain/symbol-identity-lifetime.js';
import {
  inferUniqueSymbolIdentities,
  validateSymbolIdentityLifetime,
} from '../../market-data/domain/symbol-identity-lifetime.js';
import { isCalendarDate } from '../../../../shared/schemas/rebalance-interval.js';

/** 현재 shortCode 기반 저장 구조로 안전하게 분리할 수 없는 종목 identity 조합. */
export class UnsafeBacktestSymbolIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBacktestSymbolIdentityError';
  }
}

export interface PinnedIdentityScheduleMember {
  readonly symbol: string;
  readonly standardCode: string;
}

export interface PinnedIdentityScheduleEntry {
  readonly rebalanceDate: string;
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[];
  readonly members?: readonly PinnedIdentityScheduleMember[];
}

type IdentityMaster = Pick<
  SymbolMasterService,
  'readIdentitySnapshot'
>;

/** DB에 보관된 일정 JSON의 형식과 identity를 같은 fail-closed 규칙으로 검사한다. */
export function assertSafePinnedScheduleIdentityJson(
  scheduleJson: string,
  deps: { readonly symbolMaster: IdentityMaster },
  hashPin?: { readonly expectedScheduleHash: unknown },
): readonly SymbolIdentitySelection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scheduleJson);
  } catch {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정 JSON이 손상돼 identity를 검증할 수 없습니다.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정 형식이 배열이 아니라 identity를 검증할 수 없습니다.',
    );
  }
  if (hashPin !== undefined) {
    assertPinnedScheduleHash(parsed, hashPin.expectedScheduleHash);
  }
  return assertSafePinnedScheduleIdentities(
    parsed as readonly PinnedIdentityScheduleEntry[],
    deps,
  );
}

/** 저장 schedule과 provenance pin이 동일한 결정적 JSON을 가리키는지 확인한다. */
export function assertPinnedScheduleHash(schedule: unknown, expectedScheduleHash: unknown): void {
  if (
    typeof expectedScheduleHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(expectedScheduleHash)
  ) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정 hash 형식이 올바르지 않습니다.',
    );
  }
  if (calculatePinnedScheduleHash(schedule) !== expectedScheduleHash) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정이 제출 시점 provenance hash와 일치하지 않습니다.',
    );
  }
}

/** 실제 worker가 소비한 schedule의 결정적 hash. provenance pin 부재와 무관하게 기록한다. */
export function calculatePinnedScheduleHash(schedule: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schedule);
  } catch {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정을 hash 계산용 JSON으로 직렬화할 수 없습니다.',
    );
  }
  if (serialized === undefined) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정을 hash 계산용 JSON으로 직렬화할 수 없습니다.',
    );
  }
  return createHash('sha256').update(serialized).digest('hex');
}

/** 후보가 shortCode 기반 봉·팩트에 닿기 전에 전체 SCD 생애를 검사한다. */
export function assertSafeIdentitySelections(
  symbolMaster: Pick<SymbolMasterService, 'readIdentitySnapshot'>,
  selections: readonly SymbolIdentitySelection[],
): void {
  const snapshot = symbolMaster.readIdentitySnapshot(
    selections.map((selection) => selection.shortCode),
    selections.map((selection) => selection.standardCode),
  );
  const validation = validateSymbolIdentityLifetime(selections, snapshot.versions);
  const conflict = validation.conflicts[0];
  if (conflict !== undefined) {
    throw new UnsafeBacktestSymbolIdentityError(identityConflictMessage(conflict));
  }
  // 준비 중 아직 등록되지 않은 신규 후보는 허용한다. 이미 short 또는 standard가
  // 등록돼 있다면 그 행이 exact pair여야 short-keyed 봉·팩트를 읽어도 안전하다.
  assertRegisteredIdentities(
    selections,
    snapshot.registrations,
    true,
    snapshot.unregisteredFactShortCodes,
    snapshot.uncoveredBarShortCodes,
  );
}

/**
 * 저장된 멤버십 일정의 identity pin과 현재 등록 행을 함께 검증한다.
 * modern schedule은 members 원문을 신뢰하지 않고 symbols와 정확히 같은 집합인지 먼저
 * 확인한다. legacy schedule은 전체 SCD에서 양방향 1:1일 때만 표준코드를 추론한다.
 */
export function assertSafePinnedScheduleIdentities(
  schedule: readonly PinnedIdentityScheduleEntry[],
  deps: { readonly symbolMaster: IdentityMaster },
): readonly SymbolIdentitySelection[] {
  assertPinnedScheduleExecutionDates(schedule);
  if (schedule.length === 0) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정이 비어 있어 종목 identity를 검증할 수 없습니다.',
    );
  }

  const modernSelections: SymbolIdentitySelection[] = [];
  const legacyReferences: Array<{ readonly shortCode: string; readonly effectiveDate: string }> = [];
  for (const entry of schedule) {
    if (typeof entry !== 'object' || entry === null) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정 항목 형식이 올바르지 않아 identity를 검증할 수 없습니다.',
      );
    }
    const effectiveTradingDate = entry.effectiveTradingDate;
    if (typeof effectiveTradingDate !== 'string') {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 적용 거래일 형식이 올바르지 않습니다.',
      );
    }
    if (!isCalendarDate(effectiveTradingDate)) {
      throw new UnsafeBacktestSymbolIdentityError(
        `유니버스 일정의 적용 거래일(${effectiveTradingDate})이 올바르지 않습니다.`,
      );
    }
    if (!Array.isArray(entry.symbols) || entry.symbols.some((symbol) => typeof symbol !== 'string')) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 종목 목록 형식이 올바르지 않아 identity를 검증할 수 없습니다.',
      );
    }
    const symbols = [...entry.symbols];
    const symbolSet = new Set(symbols);
    if (symbolSet.size !== symbols.length) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 종목 목록이 중복돼 identity를 검증할 수 없습니다.',
      );
    }

    if (entry.members === undefined) {
      for (const shortCode of symbols) {
        if (shortCode.length === 0) {
          throw new UnsafeBacktestSymbolIdentityError(
            '유니버스 일정에 빈 단축코드가 있어 종목 identity를 확인할 수 없습니다.',
          );
        }
        legacyReferences.push({ shortCode, effectiveDate: effectiveTradingDate });
      }
      continue;
    }

    if (
      !Array.isArray(entry.members)
      || entry.members.some((member) =>
        typeof member !== 'object'
        || member === null
        || typeof member.symbol !== 'string'
        || typeof member.standardCode !== 'string')
    ) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 identity members 형식이 올바르지 않아 실행을 차단했습니다.',
      );
    }

    const memberSymbols = entry.members.map((member) => member.symbol);
    const memberSymbolSet = new Set(memberSymbols);
    if (
      memberSymbols.length !== symbols.length
      || memberSymbolSet.size !== memberSymbols.length
      || memberSymbols.some((symbol) => !symbolSet.has(symbol))
    ) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 symbols와 identity members가 일치하지 않아 실행을 차단했습니다.',
      );
    }
    for (const member of entry.members) {
      if (member.symbol.length === 0 || member.standardCode.length === 0) {
        throw new UnsafeBacktestSymbolIdentityError(
          '유니버스 일정에 단축코드 또는 KRX 표준코드가 없는 멤버가 있습니다.',
        );
      }
      modernSelections.push({
        shortCode: member.symbol,
        standardCode: member.standardCode,
        effectiveDate: effectiveTradingDate,
      });
    }
  }

  // 일부 리밸런스 날짜의 유니버스가 비는 것은 정상이다. 다만 전체 일정이 비면
  // 실행 대상의 identity를 하나도 고정할 수 없으므로 fail-closed 한다.
  if (modernSelections.length === 0 && legacyReferences.length === 0) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정 전체가 비어 있어 종목 identity를 검증할 수 없습니다.',
    );
  }

  // legacy 추론, modern 날짜 검증, 현재 등록 owner를 같은 SQLite read snapshot에서
  // 판정한다. 별도 SELECT 사이에 SCD overlay가 commit돼 서로 다른 순간을 섞지 않는다.
  const legacyShortCodes = [...new Set(legacyReferences.map((reference) => reference.shortCode))];
  const snapshot = deps.symbolMaster.readIdentitySnapshot(
    [...modernSelections.map((selection) => selection.shortCode), ...legacyShortCodes],
    modernSelections.map((selection) => selection.standardCode),
  );
  const inferredByShort = new Map<string, string>();
  if (legacyShortCodes.length > 0) {
    const inferred = inferUniqueSymbolIdentities(legacyShortCodes, snapshot.versions);
    const conflict = inferred.conflicts[0];
    if (conflict !== undefined) {
      throw new UnsafeBacktestSymbolIdentityError(identityInferenceConflictMessage(conflict));
    }
    for (const identity of inferred.identities) {
      inferredByShort.set(identity.shortCode, identity.standardCode);
    }
  }

  const selections = [...modernSelections];
  for (const reference of legacyReferences) {
    const standardCode = inferredByShort.get(reference.shortCode);
    if (standardCode === undefined) {
      throw new UnsafeBacktestSymbolIdentityError(
        `옛 작업의 단축코드 ${reference.shortCode}에 대응하는 유일한 KRX 표준코드를 찾지 못했습니다. `
        + '미리보기를 다시 실행해 새 백테스트를 생성하세요.',
      );
    }
    selections.push({ ...reference, standardCode });
  }

  const validation = validateSymbolIdentityLifetime(selections, snapshot.versions);
  const conflict = validation.conflicts[0];
  if (conflict !== undefined) {
    throw new UnsafeBacktestSymbolIdentityError(identityConflictMessage(conflict));
  }
  assertRegisteredIdentities(
    selections,
    snapshot.registrations,
    false,
    snapshot.unregisteredFactShortCodes,
    snapshot.uncoveredBarShortCodes,
  );
  return selections;
}

/** 엔진 timestamp로 변환되는 리밸런스 날짜를 short-key 입력 접근 전에 검증한다. */
export function assertPinnedScheduleExecutionDates(
  schedule: unknown,
): asserts schedule is readonly PinnedIdentityScheduleEntry[] {
  if (!Array.isArray(schedule)) {
    throw new UnsafeBacktestSymbolIdentityError(
      '저장된 유니버스 일정 형식이 배열이 아닙니다.',
    );
  }
  for (const entry of schedule) {
    if (typeof entry !== 'object' || entry === null) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정 항목 형식이 올바르지 않아 실행할 수 없습니다.',
      );
    }
    const rebalanceDate = (entry as { readonly rebalanceDate?: unknown }).rebalanceDate;
    if (
      typeof rebalanceDate !== 'string'
      || !isCalendarDate(rebalanceDate)
      || !Number.isFinite(Date.parse(`${rebalanceDate}T00:00:00Z`))
    ) {
      throw new UnsafeBacktestSymbolIdentityError(
        '유니버스 일정의 리밸런스 날짜가 올바르지 않습니다.',
      );
    }
  }
}

function assertRegisteredIdentities(
  selections: readonly SymbolIdentityPair[],
  registrations: readonly KnownRegisteredSymbolIdentity[],
  allowCompletelyUnregistered: boolean,
  unregisteredFactShortCodes: readonly string[],
  uncoveredBarShortCodes: readonly string[],
): void {
  const registrationsByShort = new Map(registrations.map((row) => [row.code, row]));
  const registrationsByStandard = new Map(
    registrations.flatMap((row) => row.standardCode === null ? [] : [[row.standardCode, row] as const]),
  );
  const pairs = new Map<string, SymbolIdentityPair>();
  const factOrphans = new Set(unregisteredFactShortCodes);
  const uncoveredBars = new Set(uncoveredBarShortCodes);
  for (const selection of selections) {
    pairs.set(`${selection.shortCode}\0${selection.standardCode}`, selection);
  }
  for (const { shortCode, standardCode } of [...pairs.values()].sort(
    (left, right) => left.shortCode.localeCompare(right.shortCode)
      || left.standardCode.localeCompare(right.standardCode),
  )) {
    const registered = registrationsByShort.get(shortCode);
    if (uncoveredBars.has(shortCode)) {
      throw new UnsafeBacktestSymbolIdentityError(
        `${shortCode} 종목은 알려진 SCD identity 유효구간 밖의 가격 봉이 남아 있어 `
        + '과거 증권 데이터와 분리할 수 없습니다. 기존 데이터를 격리·이관한 뒤 다시 준비하세요.',
      );
    }
    if (registered === undefined) {
      const standardOwner = registrationsByStandard.get(standardCode);
      if (allowCompletelyUnregistered && standardOwner === undefined) {
        if (factOrphans.has(shortCode)) {
          throw new UnsafeBacktestSymbolIdentityError(
            `${shortCode} 종목은 현재 미등록이지만 기존 단축코드 팩트가 남아 있어 새 증권의 `
            + '데이터인지 확인할 수 없습니다. 기존 데이터를 격리·이관한 뒤 다시 준비하세요.',
          );
        }
        continue;
      }
      if (standardOwner !== undefined && standardOwner.code !== shortCode) {
        throw new UnsafeBacktestSymbolIdentityError(
          `KRX 표준코드 ${standardCode}의 기존 단축코드(${standardOwner.code})가 `
          + `선택된 종목(${shortCode})과 다릅니다. 코드 변경 전후 데이터를 현재 저장 구조로 `
          + '분리할 수 없어 실행을 차단했습니다.',
        );
      }
      throw new UnsafeBacktestSymbolIdentityError(
        `${shortCode} 종목이 현재 종목 저장소에 등록되지 않아 identity를 확인할 수 없습니다. `
        + '미리보기를 다시 실행해 종목 등록을 완료하세요.',
      );
    }
    if (registered.standardCode === null) {
      throw new UnsafeBacktestSymbolIdentityError(
        `${shortCode} 종목은 KRX 표준코드가 없는 기존 등록이라 종목 identity를 확인할 수 없습니다. `
        + '기존 데이터를 검증·이관한 뒤 미리보기를 다시 실행하세요.',
      );
    }
    if (registered.standardCode !== standardCode) {
      throw new UnsafeBacktestSymbolIdentityError(
        `${shortCode}의 기존 표준코드(${registered.standardCode})가 선택된 종목의 `
        + `표준코드(${standardCode})와 다릅니다. 단축코드 재사용 가능성이 있어 실행을 차단했습니다.`,
      );
    }
    const standardOwner = registrationsByStandard.get(standardCode);
    if (standardOwner === undefined || standardOwner.code !== shortCode) {
      throw new UnsafeBacktestSymbolIdentityError(
        `KRX 표준코드 ${standardCode}의 기존 단축코드가 선택된 종목(${shortCode})과 다릅니다. `
        + '코드 변경 전후 데이터를 현재 저장 구조로 분리할 수 없어 실행을 차단했습니다.',
      );
    }
  }
}

export function identityConflictMessage(conflict: SymbolIdentityConflict): string {
  if (conflict.kind === 'SHORT_CODE_REUSED') {
    return `단축코드 ${conflict.shortCode}이 여러 표준코드(`
      + `${conflict.standardCodes.join(', ')})에 사용된 이력이 있습니다. `
      + '현재 저장 구조는 종목별 가격·공시를 분리할 수 없어 실행을 차단했습니다.';
  }
  if (conflict.kind === 'STANDARD_CODE_REASSIGNED') {
    return `KRX 표준코드 ${conflict.standardCode}가 여러 단축코드(`
      + `${conflict.shortCodes.join(', ')})를 사용한 이력이 있습니다. `
      + '현재 실행 엔진은 코드 변경 전후 상태를 연결할 수 없어 실행을 차단했습니다.';
  }
  const active = conflict.activePairs.length === 0
    ? '해당 날짜에 연결된 pair 없음'
    : conflict.activePairs
        .map((pair) => `${pair.shortCode}/${pair.standardCode}`)
        .join(', ');
  return `${conflict.effectiveDate}에 ${conflict.shortCode}/${conflict.standardCode} identity가 `
    + `유효하지 않습니다 (${active}). 준비 일정을 신뢰할 수 없어 실행을 차단했습니다.`;
}

export function identityInferenceConflictMessage(
  conflict: SymbolIdentityInferenceConflict,
): string {
  if (conflict.kind === 'SHORT_CODE_UNKNOWN') {
    return `옛 작업의 단축코드 ${conflict.shortCode}에 대한 KRX 표준 identity 이력이 없습니다. `
      + '미리보기를 다시 실행해 새 백테스트를 생성하세요.';
  }
  return identityConflictMessage(conflict);
}
