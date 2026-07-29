import { createHash } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { Fact } from '../domain/fact.js';
import type {
  DatasetVersionBumper,
  FactIngestionGap,
  FactRepository,
  FactSource,
} from './ports.js';

export interface FactSyncRequest {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
}

export interface FactSyncReport {
  readonly savedFacts: number;
  readonly gaps: readonly FactIngestionGap[];
}

/**
 * 재무·자본변동 수집 오케스트레이션.
 * 누락(gap)은 삼키지 않고 리포트로 되돌린다 — 조용히 빠진 계정은 랭킹을 소리 없이
 * 왜곡한다 (설계 §4.1-2).
 */
export class FactSyncService {
  constructor(
    private readonly source: FactSource,
    private readonly repository: FactRepository,
    private readonly logger: Logger,
    private readonly versions: DatasetVersionBumper,
    private readonly clock: Clock,
  ) {}

  async sync(request: FactSyncRequest): Promise<FactSyncReport> {
    // 저장 전 팩트 저장소의 내용 지문. 저장 후 지문과 비교해 실제로 내용이 바뀐
    // 경우에만 버전을 올린다 — 아무것도 바뀌지 않은 idempotent 재수집이 버전을
    // 헛돌리면 "버전이 움직였다" 는 신호가 의미를 잃는다.
    const fingerprintBefore = await this.storedFactsFingerprint(request.datasetId);

    const financials = await this.source.fetchFinancials(request);
    const actions = await this.source.fetchCorporateActions(request);
    const facts = [...financials.facts, ...actions.facts];
    const gaps = [...financials.gaps, ...actions.gaps];

    await this.repository.saveFacts(request.datasetId, facts);

    await this.bumpVersionIfChanged(request.datasetId, fingerprintBefore);

    this.logger.info(
      {
        module: 'facts',
        event: 'facts.synced',
        datasetId: request.datasetId,
        savedFacts: facts.length,
        gapCount: gaps.length,
      },
      'fact sync finished',
    );

    return { savedFacts: facts.length, gaps };
  }

  /**
   * 저장된 팩트 내용이 실제로 달라졌으면 데이터셋 버전을 올린다 (§9.5).
   *
   * 지문(seed)은 "지금 저장소에 들어 있는" 팩트에서 뽑는다 — 이번에 API 가 몇 건을
   * 돌려줬는지가 아니라 저장 결과가 기준이어야 같은 내용을 다시 수집했을 때 버전이
   * 헛돌지 않는다. 버전 체인 자체는 `DatasetService.bumpVersion` 을 그대로 쓴다.
   */
  private async bumpVersionIfChanged(datasetId: string, fingerprintBefore: string): Promise<void> {
    const fingerprintAfter = await this.storedFactsFingerprint(datasetId);
    if (fingerprintAfter === fingerprintBefore) {
      this.logger.info(
        { module: 'facts', event: 'facts.version.unchanged', datasetId },
        'fact content unchanged — dataset version not bumped',
      );
      return;
    }
    this.versions.bumpVersion(datasetId, `facts:${fingerprintAfter}`, this.clock.now());
    this.logger.info(
      { module: 'facts', event: 'facts.version.bumped', datasetId },
      'dataset version bumped for fact change',
    );
  }

  /**
   * 저장소에 있는 SYMBOL 스코프 팩트 전체의 내용 지문. 정렬 후 해싱하므로 행 순서·
   * 수집 순서에 흔들리지 않는다. (MACRO 스코프는 이 수집 경로가 만들지 않는다.)
   */
  private async storedFactsFingerprint(datasetId: string): Promise<string> {
    const facts = await this.repository.getFacts({ datasetId, scope: 'SYMBOL' });
    return factsFingerprint(facts);
  }
}

/** (key, field, periodKey, asOfTsMs, value) 튜플의 정렬 해시 — 저장 내용의 지문 */
export function factsFingerprint(facts: readonly Fact[]): string {
  // 구성요소 사이에 구분자가 없으면 경계가 다른 두 조합이 같은 문자열로 충돌한다
  // (parquet-fact-repository 의 병합 키와 같은 이유) — JSON.stringify 로 이스케이프한다.
  const rows = facts
    .map((fact) =>
      JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs, fact.value]),
    )
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
