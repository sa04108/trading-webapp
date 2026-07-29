# 데이터셋 이름 변경 (인라인 편집) — 설계

날짜: 2026-07-29

## 목적

데이터셋 카드에서 이름 옆 연필 버튼으로 이름을 인라인 수정한다.

## 사전 확인: CSV import 의 name-key

`DatasetService.ensureDataset` 은 `datasets.name` 으로 기존 데이터셋을 찾는다
(import 의 upsert 의미론). 이름은 요청 시점에 즉시 id 로 해석되고, 저장된 참조는
전부 `datasetId` (백테스트·coverage·versions·jobs) 이므로 **이름 변경은 기존
데이터를 깨지 않는다**. 유일한 함정: 변경 후 *옛 이름*으로 import 하면 기존
데이터셋에 이어붙는 게 아니라 새 데이터셋이 생긴다. 이는 name-key upsert 의
본질적 동작이라 유지하되, ImportDrawer 에 기존 이름 자동완성(datalist)을 붙여
실수를 줄인다.

## API

기존 `PATCH /datasets/:datasetId` 를 확장한다 (새 엔드포인트를 만들지 않는다):

- body: `{ name?, addSymbols?, removeSymbols? }` — 최소 1개 필드 필요
- `name`: 1~64자 (생성 스키마와 동일), 앞뒤 공백 제거
- 중복 이름 → 400 (`createBrokerDataset` 의 중복 처리와 동일한 관례)
- 이름과 심볼 변경을 한 요청에 함께 보낼 수 있다

## 서비스

`DatasetService.renameDataset(datasetId, name)`:

- 미존재 데이터셋 → 오류
- 자기 자신 제외 중복 이름 → 오류 (DB unique 제약의 사전 검증)
- `name`, `updatedAtMs` 갱신, 감사 로그 `dataset.renamed` (old/new 포함)
- **버전 bump 없음** — 이름은 백테스트가 소비하는 유효 데이터가 아니다 (§9.5).
  재현성 지문은 데이터 내용만 추적한다.

## UI (DatasetCard)

- 카드 제목의 이름 옆에 연필 아이콘 버튼
- 클릭 → 이름이 Input 으로 바뀌고 저장(체크)·취소(X) 버튼 표시
- Enter = 저장, Escape = 취소, 빈 이름·변경 없음이면 저장 비활성
- 저장 성공 시 `['datasets']` 쿼리 무효화

## 테스트

- 통합: rename 성공, 중복 이름 400, name+addSymbols 동시 적용, 빈 body 400 유지
- UI 는 타입체크·린트로 검증 (기존 관례 — datasets 페이지 단위 테스트 없음)
