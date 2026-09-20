import { createOfficialKrxTradingCalendar } from "../../market-data/infrastructure/krx/krx-trading-calendar.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { SqliteDartPendingFilingStore } from "../../facts/infrastructure/dart/dart-pending-filing-store.js";
import { ProviderRequestBlockedError } from "../../../shared/provider-request-policy.js";
import { SqliteProviderRequestPolicy } from "../../../shared/provider-request-policy.js";
import { SqliteKrxRawSnapshotStore } from "../../market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js";
import { SqliteDartCorpCodeSnapshotStore } from "../../facts/infrastructure/dart/sqlite-dart-corp-code-snapshot-store.js";
import { DartFilingDiscovery, type FilingPage } from "../../facts/application/dart-filing-discovery.js";
import { RestClient } from "../../../shared/rest-client.js";
import type { AppConfig } from "../../../bootstrap/config.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { Logger } from "../../../shared/logger.js";
import type { AuditLogService } from "../../../../runtime/modules/audit/audit-service.js";
import type { ExternalApiUsage } from "../../../shared/db/external-api-usage.js";
import type { AgentDataRequest } from "../../../../shared/agent-protocol.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";
import { SymbolService } from "../../../../runtime/modules/market-data/application/symbol-service.js";
import { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import { SymbolMasterBackfill } from "../../market-data/application/symbol-master-backfill.js";
import { SymbolMasterScheduler } from "../../market-data/application/symbol-master-scheduler.js";
import { SqliteFactRepository } from "../../../../runtime/modules/facts/infrastructure/sqlite-fact-repository.js";
import { SqliteFactCoverageStore } from "../../../../runtime/modules/facts/application/fact-coverage-store.js";
import { SqliteCorporateActionCoverageStore } from "../../../../runtime/modules/facts/application/corporate-action-coverage.js";
import { FactSyncService } from "../../facts/application/fact-sync-service.js";
import { createDartFactSource } from "../../facts/infrastructure/dart/dart-fact-source.js";
import { SqliteDartRawSnapshotStore } from "../../facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js";
import { createKrxHistoricalUniverseSource } from "../../market-data/infrastructure/krx/krx-historical-universe-source.js";
import {
  AgentCollectionPaused,
  type CollectionProgressReport,
} from "./agent-data-queue.js";

type CollectionConfig = Pick<
  AppConfig,
  | "dartDiscoveryHourKst"
  | "dartApiKey"
  | "dartBaseUrl"
  | "krxApiKey"
  | "krxBaseUrl"
  | "krxApprovalExpiry"
  | "krxDailyCallBudget"
>;

/** 수집 버전 그래프의 진입점. 서버가 실제 사용하는 구현과 데이터 요구 처리기를 함께 조립한다. */
export function createAgentCollectionRuntime(input: {
  database: DatabaseHandle;
  config: CollectionConfig;
  clock: Clock;
  logger: Logger;
  auditLog: AuditLogService;
  externalApiUsage: ExternalApiUsage;
}) {
  const { database, config, clock, logger, auditLog, externalApiUsage } = input;
  const collectionActivity = new AsyncLocalStorage<{ fetched: boolean }>();
  const requestPolicy = new SqliteProviderRequestPolicy(database.sqlite, () => clock.now(), logger,
    () => { const state = collectionActivity.getStore(); if (state) state.fetched = true; });
  const collectionVersion = readRuntimeVersions().collectionVersion;
  const symbolService = new SymbolService(database.db, clock, auditLog);

  const factRepository = new SqliteFactRepository(database.db);
  const dartRawSnapshots = new SqliteDartRawSnapshotStore(database.db);
  const pendingFilings = new SqliteDartPendingFilingStore(database.sqlite, config.dartBaseUrl);
  const factSource = createDartFactSource(
    config.dartApiKey
      ? { baseUrl: config.dartBaseUrl, apiKey: config.dartApiKey }
      : null,
    logger,
    // 미래 보고서 생략(filableReportCount)이 sync 계획과 같은 시각을 봐야 한다
    { clock, usage: externalApiUsage, rawSnapshots: dartRawSnapshots, requestPolicy, pendingFilings,
      corpCodeSnapshots: new SqliteDartCorpCodeSnapshotStore(database.sqlite, config.dartBaseUrl,
        (symbol, previousCorp, nextCorp) => {
          database.sqlite.prepare(`INSERT INTO provider_input_issues
            (id, symbol, business_year, report_code, reason, evidence)
            VALUES (?, ?, NULL, NULL, 'IDENTITY_CHANGED', ?)
            ON CONFLICT(id) DO UPDATE SET evidence = excluded.evidence
            WHERE evidence <> excluded.evidence`).run(
            `dart-identity:${symbol}`, symbol,
            `DART 기업 식별자 변경: ${previousCorp} → ${nextCorp}`,
          );
        }) },
  );
  // 팩트도 백테스트 입력이다 — 캔들과 같은 버전 체인에 올린다 (§9.5).
  // SymbolService 를 통째로 넘기지 않고 좁은 포트(SymbolVersionBumper)로 받는다.
  // 팩트와 coverage가 같은 SQLite 백업·트랜잭션 경계에 있으므로 파일 교차 검사는 없다.
  const factCoverageStore = new SqliteFactCoverageStore(database.db, {
    collectionVersion,
  });
  // 자본변동 전용 수집(Task 5)이 갱신하는 별도 커버리지 — 재무 커버리지와 컬럼이
  // 다르다 (corporate-action-coverage.ts 헤더 참고).
  const actionCoverageStore = new SqliteCorporateActionCoverageStore(
    database.db,
    { collectionVersion },
  );
  const factSyncService = new FactSyncService(
    factSource,
    factRepository,
    logger,
    symbolService,
    clock,
    factCoverageStore,
    actionCoverageStore,
  );
  // KRX 과거 시점 조회 (설계 2026-08-03-krx-historical-universe). API 키 미설정이면
  // 어댑터가 포트 에러를 던지는 비활성 소스가 된다 — 다른 데이터 경로와 같은 패턴
  // (§2.4 조립부 전용 지식). 과거 손으로 스냅샷을 확정하던 화면(데이터셋·유니버스
  // 스냅샷, 스펙 2026-08-05 Task 6 가 제거)은 사라졌고, 지금은 종목 마스터가 이
  // 소스를 직접 쓴다.
  const krxSource = createKrxHistoricalUniverseSource(
    config.krxApiKey
      ? {
          baseUrl: config.krxBaseUrl,
          apiKey: config.krxApiKey,
          approvalExpiry: config.krxApprovalExpiry,
        }
      : null,
    clock,
    logger,
    { usage: externalApiUsage, requestPolicy, tradingCalendar: createOfficialKrxTradingCalendar(), rawNamespace: config.krxBaseUrl,
      rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db) },
  );
  // 종목 마스터 (설계 2026-08-05-symbol-master-core).
  const symbolMasterService = new SymbolMasterService({
    db: database.db,
    collectionVersion,
    source: krxSource,
    clock,
    logger,
  });
  const symbolMasterBackfill = new SymbolMasterBackfill({
    service: symbolMasterService,
    source: krxSource,
    clock,
    logger,
    dailyCallBudget: config.krxDailyCallBudget,
  });
  const symbolMasterScheduler = new SymbolMasterScheduler({
    service: symbolMasterService,
    backfill: symbolMasterBackfill,
    clock,
    logger,
  });
  let reconciliation: Promise<void> | null = null;
  let reconciliationStopped = false;
  const reconcileProviderFilings = (): Promise<void> => {
    if (reconciliationStopped) return Promise.resolve();
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
      for (const item of pendingFilings.reconcileDiscoveredFilings()) {
        try {
          const request = { symbols: [item.symbol], fromYear: item.year, toYear: item.year,
            consolidated: true, mode: "FULL" as const };
          const financial = await factSyncService.sync(request, { shouldStop: () => reconciliationStopped });
          const actions = await factSyncService.syncCorporateActions(request, { shouldStop: () => reconciliationStopped });
          if (financial.stopReason == null && actions.stopReason == null) {
            pendingFilings.markNormalized(item.symbol, item.year);
            const issue = database.sqlite.prepare("SELECT 1 FROM provider_input_issues WHERE symbol = ? AND (business_year IS NULL OR business_year = ?) LIMIT 1")
              .get(item.symbol, item.year);
            if (!issue) database.sqlite.prepare(`UPDATE agent_data_requests SET status = 'QUEUED', next_attempt_at_ms = 0
              WHERE status = 'BLOCKED' AND error LIKE 'PENDING_PUBLICATION:%'
              AND json_extract(request_json, '$.fromYear') <= ? AND json_extract(request_json, '$.toYear') >= ?
              AND EXISTS (SELECT 1 FROM json_each(request_json, '$.symbols') WHERE value = ?)`)
              .run(item.year, item.year, item.symbol);
          }
        } catch (error) {
          logger.warn({ event: "provider.filing.pending", symbol: item.symbol, year: item.year,
            blocked: error instanceof ProviderRequestBlockedError, err: error }, "공시 반영 대기");
        }
      }
    })().catch((error: unknown) => {
      logger.error({err:error}, "공시 반영 상태 재평가 실패");
    }).finally(() => { reconciliation = null; });
    return reconciliation;
  };
  const discoveryClient = new RestClient({ baseUrl: config.dartBaseUrl, logger });
  const filingDiscovery = new DartFilingDiscovery({
    sqlite: database.sqlite, logger, now: () => clock.now(), hourKst: config.dartDiscoveryHourKst, onPageStored: async () => { pendingFilings.reconcileDiscoveredFilings(); },
    fetchPage: config.dartApiKey ? async (from, to, page, beforeAttempt) => {
      const parameters = { bgn_de: from.replaceAll("-", ""), end_de: to.replaceAll("-", ""),
        pblntf_ty: "A", page_no: String(page), page_count: "100" };
      const query = new URLSearchParams({ ...parameters, crtfc_key: config.dartApiKey! });
      const envelope = await discoveryClient.request<FilingPage>("dart-discovery", `/api/list.json?${query}`, {}, {
        beforeAttempt: () => {
          beforeAttempt();
          if (externalApiUsage.quotaExceeded("DART", "daily")) throw new Error("DART 일일 한도 대기");
          const callsUsed = externalApiUsage.recordCall("DART", "daily");
          logger.info({ event: "provider.http", activity: "FILING_DISCOVERY", endpoint: "/api/list.json",
            requestKey: parameters, callsUsed }, "일일 공시 목록 요청");
        },
      });
      if (envelope.status === "020") externalApiUsage.reportQuotaExceeded("DART", "daily", "DART 일일 호출 한도 초과");
      return envelope;
    } : null,
  });
  const collectData = async (
    request: AgentDataRequest,
    shouldStop: () => boolean,
    onProgress: (progress: CollectionProgressReport) => void,
  ): Promise<void> => {
    if (request.kind === "MARKET") {
      for (const [index, date] of request.dates.entries()) {
        if (shouldStop()) return;
        await symbolMasterService.ensureTradingDay(date);
        onProgress({
          activity: "COLLECTING_MARKET",
          unit: "DATES",
          completed: index + 1,
          total: request.dates.length,
          currentItem: date,
        });
      }
    } else if (request.kind === "SELECTION") {
      for (const [index, date] of request.dates.entries()) {
        if (shouldStop()) return;
        await symbolMasterService.ensureSelectionMetrics([date]);
        onProgress({
          activity: "COLLECTING_SELECTION",
          unit: "DATES",
          completed: index + 1,
          total: request.dates.length,
          currentItem: date,
        });
      }
    } else if (request.kind === "REGISTER") {
      for (const [index, entry] of request.symbols.entries()) {
        if (shouldStop()) return;
        const registered = symbolService.getRegisteredIdentity(entry.symbol);
        if (registered) {
          if (registered.standardCode !== entry.standardCode)
            throw new Error("종목 표준코드가 기존 등록과 다릅니다");
          onProgress({
            activity: "REGISTERING_SYMBOLS",
            unit: "SYMBOLS",
            completed: index + 1,
            total: request.symbols.length,
            currentItem: entry.symbol,
          });
          continue;
        }
        const row = database.sqlite
          .prepare(
            "SELECT name FROM symbol_master_versions WHERE short_code = ? AND standard_code = ? LIMIT 1",
          )
          .get(entry.symbol, entry.standardCode) as
          { name: string } | undefined;
        if (!row) throw new Error("수집된 종목 마스터에 없는 표준코드입니다");
        symbolService.addSymbol(
          entry.symbol,
          "KR",
          row.name,
          entry.standardCode,
        );
        onProgress({
          activity: "REGISTERING_SYMBOLS",
          unit: "SYMBOLS",
          completed: index + 1,
          total: request.symbols.length,
          currentItem: entry.symbol,
        });
      }
    } else {
      const input = {
        ...request,
        mode: "INCREMENTAL" as const,
        consolidated: true,
      };
      const reportSymbol = (progress: { symbol: string; index: number; total: number }) =>
        onProgress({
          activity:
            request.kind === "FINANCIAL"
              ? "COLLECTING_FINANCIALS"
              : "COLLECTING_ACTIONS",
          unit: "SYMBOLS",
          completed: progress.index,
          total: progress.total,
          currentItem: progress.symbol,
        });
      const syncReport =
        request.kind === "FINANCIAL"
          ? await factSyncService.sync(input, {
              shouldStop,
              onSymbolDone: reportSymbol,
            })
          : await factSyncService.syncCorporateActions(input, {
              shouldStop,
              onSymbolDone: reportSymbol,
            });
      if (syncReport.stopReason === "DAILY_QUOTA") {
        const next =
          Math.floor((clock.now() + 9 * 3600_000) / 86400_000 + 1) * 86400_000 -
          9 * 3600_000;
        throw new AgentCollectionPaused(
          syncReport.failureMessage ?? "DART 일일 호출 한도 대기",
          next,
        );
      }
      if (syncReport.stopReason === "ERROR")
        throw new Error(syncReport.failureMessage ?? "DART 수집 실패");
    }
  };
  const collect = (request: AgentDataRequest, shouldStop: () => boolean,
    report: (progress: CollectionProgressReport) => void): Promise<void> =>
    collectionActivity.run({fetched:false}, () => collectData(request, shouldStop, (progress) => {
      const activity = progress.activity.startsWith("COLLECTING_")
        ? collectionActivity.getStore()?.fetched ? "SOURCE_FETCH" : "LOCAL_REPLAY" : progress.activity;
      report({...progress,activity});
    }));
  return {
    requestPolicy,
    filingDiscovery,
    reconcileProviderFilings,
    stopProviderReconciliation: async () => { reconciliationStopped = true; await reconciliation; },
    symbolService,
    factRepository,
    factCoverageStore,
    actionCoverageStore,
    factSyncService,
    krxSource,
    symbolMasterService,
    symbolMasterBackfill,
    symbolMasterScheduler,
    collect,
  };
}
