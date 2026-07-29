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

/** 종목 하나가 끝날 때마다 호출된다 — 40분짜리 실행이 조용하지 않게 한다 */
export interface FactSyncProgress {
  readonly symbol: string;
  /** 1부터 시작하는 진행 번호 */
  readonly index: number;
  readonly total: number;
  /** 이 종목에서 저장된 팩트 수 */
  readonly savedFacts: number;
  /** 이 종목에서 남은 누락 수 */
  readonly gapCount: number;
}

export interface FactSyncHooks {
  onSymbolDone?(progress: FactSyncProgress): void;
}

export interface FactSyncReport {
  readonly savedFacts: number;
  readonly gaps: readonly FactIngestionGap[];
  /** 중단된 종목코드. 완주하면 null */
  readonly stoppedAtSymbol: string | null;
  /** 중단 사유 + 이어받는 방법을 담은 한국어 안내. 완주하면 null */
  readonly failureMessage: string | null;
}

/**
 * 재무·자본변동 수집 오케스트레이션.
 *
 * 누락(gap)은 삼키지 않고 리포트로 되돌린다 — 조용히 빠진 계정은 랭킹을 소리 없이
 * 왜곡한다 (설계 §4.1-2).
 *
 * **종목 단위로 수집하고 종목 단위로 저장한다.** 전 종목을 모아 마지막에 한 번 저장하면
 * 200종목 × 12년 백필(종목·연도당 9회 ≈ 21,600 호출, 일 한도 20,000, rate limiter 로
 * 최소 40분)에서 180번째 종목의 오류 하나가 앞선 179종목의 결과를 통째로 버린다 —
 * 한도는 이미 소진된 상태로. 저장을 종목마다 끊으면 다시 실행할 때 `--from`/`--to` 를
 * 좁혀 남은 구간만 이어받을 수 있다.
 */
export class FactSyncService {
  constructor(
    private readonly source: FactSource,
    private readonly repository: FactRepository,
    private readonly logger: Logger,
    private readonly versions: DatasetVersionBumper,
    private readonly clock: Clock,
  ) {}

  async sync(request: FactSyncRequest, hooks: FactSyncHooks = {}): Promise<FactSyncReport> {
    // 저장 전 팩트 저장소의 내용 지문. 저장 후 지문과 비교해 실제로 내용이 바뀐
    // 경우에만 버전을 올린다 — 아무것도 바뀌지 않은 idempotent 재수집이 버전을
    // 헛돌리면 "버전이 움직였다" 는 신호가 의미를 잃는다.
    const fingerprintBefore = await this.storedFactsFingerprint(request.datasetId);

    const gaps: FactIngestionGap[] = [];
    let savedFacts = 0;
    let doneSymbols = 0;
    let stoppedAtSymbol: string | null = null;
    let failureReason: string | null = null;

    for (const [index, symbol] of request.symbols.entries()) {
      try {
        const scoped = { ...request, symbols: [symbol] };
        // 종목별 호출이지만 corp_code 매핑과 주식총수(stockTotqySttus) 응답 캐시는 소스
        // 인스턴스 클로저 안에 살아 있다 — 종목마다 다시 내려받지 않는다
        // (dart-fact-source.ts 의 corpCodes·shareRowsCache 참고).
        const financials = await this.source.fetchFinancials(scoped);
        const actions = await this.source.fetchCorporateActions(scoped);
        const facts = [...financials.facts, ...actions.facts];
        const symbolGaps = [...financials.gaps, ...actions.gaps];

        // 종목마다 저장한다 — 뒤에서 터져도 여기까지는 남는다
        await this.repository.saveFacts(request.datasetId, facts);

        savedFacts += facts.length;
        doneSymbols += 1;
        gaps.push(...symbolGaps);
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: request.symbols.length,
          savedFacts: facts.length,
          gapCount: symbolGaps.length,
        });
      } catch (error) {
        // 그대로 던지면 지금까지 저장한 것을 알려줄 자리가 없다 — 리포트로 되돌려
        // CLI 가 어디까지 갔는지, 어떻게 이어받는지 말하게 한다.
        stoppedAtSymbol = symbol;
        failureReason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          {
            module: 'facts',
            event: 'facts.sync.aborted',
            datasetId: request.datasetId,
            symbol,
            symbolIndex: index + 1,
            symbolTotal: request.symbols.length,
            savedFacts,
            err: error,
          },
          'fact sync aborted — earlier symbols are already saved',
        );
        break;
      }
    }

    // 중단된 실행에서도 부른다 — 팩트가 저장됐다면 데이터셋 내용은 이미 바뀌었다
    await this.bumpVersionIfChanged(request.datasetId, fingerprintBefore);

    this.logger.info(
      {
        module: 'facts',
        event: 'facts.synced',
        datasetId: request.datasetId,
        savedFacts,
        gapCount: gaps.length,
        stoppedAtSymbol,
      },
      'fact sync finished',
    );

    return {
      savedFacts,
      gaps,
      stoppedAtSymbol,
      failureMessage:
        stoppedAtSymbol === null
          ? null
          : `수집이 ${stoppedAtSymbol} 에서 중단됐습니다 ` +
            `(${doneSymbols}/${request.symbols.length}종목 완료). ` +
            `사유: ${failureReason ?? '알 수 없음'}. ` +
            `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다시 실행할 때 ` +
            `--from/--to 를 좁히면 남은 구간만 이어받을 수 있습니다.`,
    };
  }

  /**
   * 저장된 팩트 내용이 실제로 달라졌으면 데이터셋 버전을 올린다 (§9.5).
   *
   * 지문(seed)은 "지금 저장소에 들어 있는" 팩트에서 뽑는다 — 이번에 API 가 몇 건을
   * 돌려줬는지가 아니라 저장 결과가 기준이어야 같은 내용을 다시 수집했을 때 버전이
   * 헛돌지 않는다. 버전 체인 자체는 `DatasetService.bumpVersion` 을 그대로 쓴다.
   *
   * 중단된 실행에서도 호출된다 — 저장된 것이 있으면 데이터셋 내용은 이미 달라졌다.
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
