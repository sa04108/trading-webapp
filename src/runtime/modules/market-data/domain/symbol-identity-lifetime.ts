/** 백테스트 일정이나 후보군이 참조하는 KRX 종목 identity. */
export interface SymbolIdentitySelection {
  readonly shortCode: string;
  readonly standardCode: string;
  /** 이 날짜에 정확한 (standardCode, shortCode) pair가 유효해야 한다. */
  readonly effectiveDate: string;
}

/** identity 검증에 필요한 symbol_master_versions의 최소 projection. */
export interface KnownSymbolIdentityVersion {
  readonly shortCode: string;
  readonly standardCode: string;
  readonly validFromDate: string;
  readonly validToDate: string | null;
}

export interface SymbolIdentityPair {
  readonly shortCode: string;
  readonly standardCode: string;
}

export type SymbolIdentityConflict =
  | {
      readonly kind: 'SHORT_CODE_REUSED';
      readonly shortCode: string;
      readonly standardCodes: readonly string[];
    }
  | {
      readonly kind: 'STANDARD_CODE_REASSIGNED';
      readonly standardCode: string;
      readonly shortCodes: readonly string[];
    }
  | {
      readonly kind: 'PAIR_NOT_EFFECTIVE';
      readonly shortCode: string;
      readonly standardCode: string;
      readonly effectiveDate: string;
      /** 그 날짜에 selection의 short 또는 standard와 연결돼 있던 실제 pair. */
      readonly activePairs: readonly SymbolIdentityPair[];
    };

export interface SymbolIdentityValidationResult {
  readonly safe: boolean;
  readonly conflicts: readonly SymbolIdentityConflict[];
}

export type SymbolIdentityInferenceConflict =
  | Extract<
      SymbolIdentityConflict,
      { readonly kind: 'SHORT_CODE_REUSED' | 'STANDARD_CODE_REASSIGNED' }
    >
  | {
      readonly kind: 'SHORT_CODE_UNKNOWN';
      readonly shortCode: string;
    };

export interface SymbolIdentityInferenceResult {
  readonly safe: boolean;
  /** 전체 생애에서 short↔standard 양방향이 모두 1:1인 요청만 포함한다. */
  readonly identities: readonly SymbolIdentityPair[];
  readonly conflicts: readonly SymbolIdentityInferenceConflict[];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function addToArrayMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function pairKey(pair: SymbolIdentityPair): string {
  return `${pair.standardCode}\u0000${pair.shortCode}`;
}

function comparePair(left: SymbolIdentityPair, right: SymbolIdentityPair): number {
  return left.standardCode.localeCompare(right.standardCode)
    || left.shortCode.localeCompare(right.shortCode);
}

function isEffective(version: KnownSymbolIdentityVersion, date: string): boolean {
  return version.validFromDate <= date
    && (version.validToDate === null || version.validToDate > date);
}

/**
 * 선택 identity를 알려진 SCD 전체 생애와 대조한다.
 *
 * 종목명·시장·주식수 같은 메타데이터 버전은 identity를 바꾸지 않으므로 pair set으로
 * 축약한다. 같은 pair가 폐지 뒤 다시 나타난 경우도 허용한다. 반대로 단축코드 하나가
 * 여러 표준코드에, 또는 표준코드 하나가 여러 단축코드에 연결된 적이 있으면 현재
 * shortCode 기반 봉·팩트 저장 구조로 발행사를 분리할 수 없으므로 충돌이다.
 */
export function validateSymbolIdentityLifetime(
  selections: readonly SymbolIdentitySelection[],
  knownVersions: readonly KnownSymbolIdentityVersion[],
): SymbolIdentityValidationResult {
  const standardsByShort = new Map<string, Set<string>>();
  const shortsByStandard = new Map<string, Set<string>>();
  const versionsByPair = new Map<string, KnownSymbolIdentityVersion[]>();
  const versionsByShort = new Map<string, KnownSymbolIdentityVersion[]>();
  const versionsByStandard = new Map<string, KnownSymbolIdentityVersion[]>();

  // DB에 아직 없더라도 서로 충돌하는 두 selection을 놓치지 않게 입력 pair도 edge다.
  for (const pair of [...selections, ...knownVersions]) {
    addToSetMap(standardsByShort, pair.shortCode, pair.standardCode);
    addToSetMap(shortsByStandard, pair.standardCode, pair.shortCode);
  }
  for (const version of knownVersions) {
    addToArrayMap(versionsByPair, pairKey(version), version);
    addToArrayMap(versionsByShort, version.shortCode, version);
    addToArrayMap(versionsByStandard, version.standardCode, version);
  }

  const conflicts: SymbolIdentityConflict[] = [];
  for (const [shortCode, standards] of [...standardsByShort].sort(([a], [b]) => a.localeCompare(b))) {
    if (standards.size <= 1) continue;
    conflicts.push({
      kind: 'SHORT_CODE_REUSED',
      shortCode,
      standardCodes: [...standards].sort(),
    });
  }
  for (const [standardCode, shorts] of [...shortsByStandard].sort(([a], [b]) => a.localeCompare(b))) {
    if (shorts.size <= 1) continue;
    conflicts.push({
      kind: 'STANDARD_CODE_REASSIGNED',
      standardCode,
      shortCodes: [...shorts].sort(),
    });
  }

  const effectiveSelections = new Map<string, SymbolIdentitySelection>();
  for (const selection of selections) {
    effectiveSelections.set(
      `${selection.effectiveDate}\u0000${pairKey(selection)}`,
      selection,
    );
  }
  for (const selection of [...effectiveSelections.values()].sort(
    (a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || comparePair(a, b),
  )) {
    const effectiveDate = selection.effectiveDate;
    const exactPairIsEffective = (versionsByPair.get(pairKey(selection)) ?? [])
      .some((version) => isEffective(version, effectiveDate));
    if (exactPairIsEffective) continue;

    const activePairsByKey = new Map<string, SymbolIdentityPair>();
    const connectedVersions = [
      ...(versionsByShort.get(selection.shortCode) ?? []),
      ...(versionsByStandard.get(selection.standardCode) ?? []),
    ];
    for (const version of connectedVersions) {
      if (!isEffective(version, effectiveDate)) continue;
      const pair = { shortCode: version.shortCode, standardCode: version.standardCode };
      activePairsByKey.set(pairKey(pair), pair);
    }
    conflicts.push({
      kind: 'PAIR_NOT_EFFECTIVE',
      shortCode: selection.shortCode,
      standardCode: selection.standardCode,
      effectiveDate,
      activePairs: [...activePairsByKey.values()].sort(comparePair),
    });
  }

  return { safe: conflicts.length === 0, conflicts };
}

/**
 * 표준코드가 없는 legacy shortCode를 알려진 전체 SCD에서 추론한다.
 * 한 방향이라도 1:1이 아니거나 알려진 버전이 없으면 identity를 만들지 않는다.
 */
export function inferUniqueSymbolIdentities(
  requestedShortCodes: readonly string[],
  knownVersions: readonly KnownSymbolIdentityVersion[],
): SymbolIdentityInferenceResult {
  const standardsByShort = new Map<string, Set<string>>();
  const shortsByStandard = new Map<string, Set<string>>();
  for (const version of knownVersions) {
    addToSetMap(standardsByShort, version.shortCode, version.standardCode);
    addToSetMap(shortsByStandard, version.standardCode, version.shortCode);
  }

  const requested = [...new Set(requestedShortCodes)].sort();
  const reused: Extract<SymbolIdentityInferenceConflict, { kind: 'SHORT_CODE_REUSED' }>[] = [];
  const unknown: Extract<SymbolIdentityInferenceConflict, { kind: 'SHORT_CODE_UNKNOWN' }>[] = [];
  const ambiguousStandards = new Set<string>();
  const identities: SymbolIdentityPair[] = [];

  for (const shortCode of requested) {
    const standards = standardsByShort.get(shortCode);
    if (standards === undefined || standards.size === 0) {
      unknown.push({ kind: 'SHORT_CODE_UNKNOWN', shortCode });
      continue;
    }
    const sortedStandards = [...standards].sort();
    if (sortedStandards.length > 1) {
      reused.push({
        kind: 'SHORT_CODE_REUSED',
        shortCode,
        standardCodes: sortedStandards,
      });
      for (const standardCode of sortedStandards) {
        if ((shortsByStandard.get(standardCode)?.size ?? 0) > 1) {
          ambiguousStandards.add(standardCode);
        }
      }
      continue;
    }

    const standardCode = sortedStandards[0]!;
    const linkedShorts = shortsByStandard.get(standardCode) ?? new Set<string>();
    if (linkedShorts.size > 1) {
      ambiguousStandards.add(standardCode);
      continue;
    }
    identities.push({ shortCode, standardCode });
  }

  const reassigned: Extract<
    SymbolIdentityInferenceConflict,
    { kind: 'STANDARD_CODE_REASSIGNED' }
  >[] = [...ambiguousStandards].sort().map((standardCode) => ({
    kind: 'STANDARD_CODE_REASSIGNED',
    standardCode,
    shortCodes: [...(shortsByStandard.get(standardCode) ?? [])].sort(),
  }));
  const conflicts: SymbolIdentityInferenceConflict[] = [...reused, ...reassigned, ...unknown];
  return { safe: conflicts.length === 0, identities, conflicts };
}
