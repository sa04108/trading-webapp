// 포트 계약 에러의 별칭 재수출 — 정의는 market-data/application/ports.ts (설계 문서
// 2026-07-28-broker-sync-design.md 갭 1). broker 쪽 기존 import 경로를 보존한다.
export { MarketDataSourceNotConfiguredError as BrokerNotConfiguredError } from '../../market-data/application/ports.js';
