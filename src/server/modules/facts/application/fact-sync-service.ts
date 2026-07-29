import type { Logger } from '../../../shared/logger.js';
import type { FactIngestionGap, FactRepository, FactSource } from './ports.js';

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
  ) {}

  async sync(request: FactSyncRequest): Promise<FactSyncReport> {
    const financials = await this.source.fetchFinancials(request);
    const actions = await this.source.fetchCorporateActions(request);
    const facts = [...financials.facts, ...actions.facts];
    const gaps = [...financials.gaps, ...actions.gaps];

    await this.repository.saveFacts(request.datasetId, facts);

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
}
