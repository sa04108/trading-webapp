# IMPLEMENTATION STATUS

기준: `PLAN.md` / 스펙 §36 Phase 0~5 (MVP)

| Phase | 내용 | 상태 |
|---|---|---|
| 0 | 기반 (스캐폴딩, config, health, 경계 검사) | 진행 중 |
| 1 | 인증·UI shell (Argon2id, TOTP, 세션, 감사 로그, 내비게이션) | 미착수 |
| 2 | 데이터 (Candle, Parquet/DuckDB, CSV import, coverage, 집계) | 미착수 |
| 3 | 엔진 (체결, 비용, 이벤트 루프, 지표, 결정성, look-ahead) | 미착수 |
| 4 | 작업 큐 (SQLite 큐, 자식 프로세스, IPC, 취소, 복구) | 미착수 |
| 5 | 결과 UI (지표 카드, 차트, 거래 테이블, 위저드, SSE) | 미착수 |
| 6 | AWS 인프라 (infra/ 설정 파일 생성만, 실서버 적용은 사용자) | 미착수 |

## 알려진 제약

- 키움 REST 어댑터는 App Key 발급 전까지 비활성 (D-002)
- KR 공휴일 캘린더 미반영 (D-006)
- 개발 머신 Node 22 / 운영 Node 24 (D-001)

## 검증 게이트 이력

| 일자 | Phase | lint | typecheck | test | build |
|---|---|---|---|---|---|
| - | - | - | - | - | - |
