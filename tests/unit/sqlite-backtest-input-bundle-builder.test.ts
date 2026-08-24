import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteBacktestInputBundleBuilder } from '../../src/server/modules/backtest/infrastructure/sqlite-backtest-input-bundle-builder.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import {
  backtestJobs,
  symbolFactsState,
  symbolMasterCoverage,
  symbols,
} from '../../src/server/shared/db/schema.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteBacktestInputBundleBuilder', () => {
  it('선택 종목의 자본변동 상태와 전역 종목 마스터 coverage를 원격 bundle에 복사한다', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-input-bundle-'));
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, 'source.sqlite');
    const destinationPath = path.join(directory, 'destination.sqlite');
    const source = openDatabase(sourcePath);
    source.db.insert(symbols).values([
      { code: 'SELECTED', market: 'KR', name: null, createdAtMs: 1 },
      { code: 'OTHER', market: 'KR', name: null, createdAtMs: 1 },
    ]).run();
    source.db.insert(symbolFactsState).values([
      {
        code: 'SELECTED',
        coveredYearsJson: '[]',
        actionCoveredYearsJson: '[2025]',
        actionGapYearsJson: '[2025]',
        actionCoverageProtocolJson: '{"version":2,"years":[2025]}',
        updatedAtMs: 10,
        actionUpdatedAtMs: 10,
      },
      {
        code: 'OTHER',
        coveredYearsJson: '[]',
        actionCoveredYearsJson: '[2024]',
        actionGapYearsJson: '[2024]',
        actionCoverageProtocolJson: '{"version":2,"years":[2024]}',
        updatedAtMs: 20,
        actionUpdatedAtMs: 20,
      },
    ]).run();
    source.db.insert(symbolMasterCoverage).values([
      { startDate: '2025-01-01', endDate: '2025-12-31', syncedAtMs: 30 },
      { startDate: '2026-01-01', endDate: '2026-12-31', syncedAtMs: 40 },
    ]).run();
    source.db.insert(backtestJobs).values({
      id: 'job_bundle_gap',
      status: 'QUEUED',
      requestJson: '{}',
      strategyId: 'range-breakout',
      universeRuleJson: '{}',
      universeScheduleJson: JSON.stringify([{
        rebalanceDate: '2025-01-02',
        effectiveTradingDate: '2025-01-02',
        symbols: ['SELECTED'],
      }]),
      createdAtMs: 1,
    }).run();
    source.close();

    new SqliteBacktestInputBundleBuilder().build(
      sourcePath,
      destinationPath,
      'job_bundle_gap',
    );

    const destination = openDatabase(destinationPath);
    const states = destination.db.select().from(symbolFactsState).all();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      code: 'SELECTED',
      actionCoveredYearsJson: '[2025]',
      actionGapYearsJson: '[2025]',
      actionCoverageProtocolJson: '{"version":2,"years":[2025]}',
    });
    expect(destination.db.select().from(symbolMasterCoverage).all()).toMatchObject([
      { startDate: '2025-01-01', endDate: '2025-12-31', syncedAtMs: 30 },
      { startDate: '2026-01-01', endDate: '2026-12-31', syncedAtMs: 40 },
    ]);
    destination.close();
  });
});
