# 종목을 1급 객체로 — 데이터셋은 참조만 갖는다

## 왜

재무 팩트가 `dataset=<id>` 파티션 아래 있어 같은 종목이 N개 데이터셋에 N번 복제된다.
비용은 디스크가 아니라 **DART 일일 호출 한도**다 (`DART_CALLS_PER_SYMBOL_YEAR = 9`,
한도 40,000/일):

| 시나리오 | 호출 | 한도 대비 |
|---|---|---|
| 200종목 · 50년 · **1개** 데이터셋 | 90,000 | 225% |
| 200종목 · 50년 · 10개 데이터셋 | 900,000 | 2,250% (~23일) |

데이터셋 하나만으로도 이미 한도를 넘는다. 중복은 그것을 N배로 만든다.

두 번째 비용은 중복과 무관하다. `ParquetFactRepository.writePartition` 이 **매 수집마다**
파티션 전체를 JS 로 읽어 Map 으로 병합하고 통째로 다시 쓴다. 48만 행이면 SQL `VALUES`
문자열만 ~38MB 다 — `MemoryMax=640M`, DuckDB 384MB 박스(D-030·D-023)에서 디스크가 차기
훨씬 전에 죽는다. **종목 단위 파티션이 두 문제를 동시에 없앤다**: 중복이 사라져 호출이
1/N 로 줄고, 쓰기가 해당 종목 몫만 다시 쓴다.

`parquet-fact-repository.ts` 가 데이터셋 파티션을 정당화한 근거는 유효기간이 지났다 —
"작다: 200종목 × **20분기** × 12필드 ≈ 5만 행" 은 5년 전제다. 50년이면 200분기, 48만 행.

봉도 같이 옮긴다. 수집이 종목 단위가 되어야 화면이 종목별 상태를 말할 수 있고,
데이터셋이 "종목 참조 묶음" 이라는 정의와 일치한다.

## 모델

```
symbols             code(PK) · market · name · createdAtMs
symbol_slices       (code, slice) · syncedFirst/LastTsMs · backfillDoneAtMs
symbol_coverage     (code, slice) · first/lastTsMs · barCount · expected · missing · computedAtMs
symbol_facts_state  code(PK) · coveredYearsJson · updatedAtMs
symbol_versions     (code, slice) · version · contentHash · createdAtMs
datasets            id · name · description · createdAtMs
dataset_symbols     (datasetId, code)
data_sync_jobs      id · status · sourceType · symbolsJson · phase · factsJson · …
```

없어지는 것: `datasets.market`·`defaultTimeframe`·`symbolsJson`·`symbolsKey`,
`dataset_versions`, `data_coverage`, `broker_sync_state`, `dataset_facts_state`,
`data_import_jobs`.

`market` 은 종목의 속성이다. 소비 봉 주기는 이미 백테스트 요청 필드이므로
데이터셋이 들고 있을 이유가 없다.

Parquet 에서 최상위 `dataset=` 파티션이 사라진다:

```
market-data/
├─ market=KR/timeframe=1m/symbol=005930/year=2026/month=07/data.parquet
├─ market=KR/timeframe=1h/symbol=005930/year=2026/data.parquet
└─ facts/scope=SYMBOL/symbol=005930/data.parquet
```

## 재현성 (§9.5)

종목 데이터를 공유하면 데이터셋 내용이 고정되지 않는다 — 누군가 종목을 동기화하면 그
종목을 참조하는 모든 데이터셋의 입력이 변한다. `datasetVersion`·`datasetHash` 로는 더
이상 "이 실행이 무엇을 돌렸나" 에 답할 수 없다.

**종목별 버전 + 실행 스냅샷으로 옮긴다.** `symbol_versions` 를 두고 수집 성공마다
`(code, slice)` 의 version 을 올린다. `backtest_runs` 는:

```
- datasetVersion, datasetHash        (제거)
+ universeHash   TEXT   sha256(정렬된 "code:slice:version:contentHash" 목록)
+ universeJson   TEXT   [{code, slice, version, contentHash}]
```

`datasetId` 는 남긴다 — "어느 데이터셋을 골랐나" 는 여전히 기록할 값이다. 다만 실행이
실제로 무엇을 소비했는지는 `universeJson` 이 답한다.

기존 `datasetVersions.contentHash` 는 바이트 다이제스트가 아니라 계보 해시였다
(직전 해시 + fingerprintSeed). 종목별 버전도 같은 성질을 유지한다 — 데이터가 바뀌면
해시가 바뀐다는 보장이지 내용을 재구성할 수 있다는 뜻은 아니다.

## 화면

데이터 탭을 **데이터셋 / 종목** 두 구획으로 나눈다.

### 종목

```
┌────────────────────────────────────────────────┐
│ 종목                        [+ 추가]  [편집]    │
├────────────────────────────────────────────────┤
│ ☐ 삼성전자 005930           일봉 분봉 재무      │
│   일봉 3일 전 · 분봉 2개월 전 · 데이터셋 2곳    │
├────────────────────────────────────────────────┤
│ ☐ 카카오 035720             일봉 ·분봉· ·재무·  │
│   일봉 21일 전 · 데이터셋 1곳                   │
└────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────┐
   │ 3개 선택  전체선택 │ ☐재무 │ 동기화  제거 │  ← sticky
   └──────────────────────────────────────────┘
```

- 「편집」 을 누르면 체크박스가 나타나고, 하나 이상 체크되면 동기화·제거가 열린다.
- **동작 바는 하단 고정.** 종목 200개에서 아래쪽을 체크한 뒤 버튼을 찾아 다시 올라가야
  하는 일을 없앤다. **전체 선택**도 여기 둔다 — 200개를 하나씩 누르게 할 수 없다.
- **봉 유무는 슬라이스별로.** 「봉 있음」 하나로 접으면 *분봉이 없다* 가 숨는다. 일봉만
  있는 종목으로 분봉 백테스트를 제출하면 그때 알게 되는데, D-032·D-033 에서 계속 막아 온
  실패 방식이다.
- **마지막 동기화도 슬라이스별로.** 워터마크가 (종목, 슬라이스) 단위라 값이 하나가 아니다.
  일봉 3일 전 · 분봉 2개월 전인 종목에 「3일 전」만 쓰면 거짓말이다.
- **참조 데이터셋 수를 행에 적는다.** 제거를 안전하게 만들고, 종목 쪽에서 관계가 보인다.
- 재무 체크박스는 기존 안전장치를 이어받는다 — DART 는 국내 전용이고 API 키가 필요하다
  (D-027). 비KR 이 섞이거나 키가 없으면 잠그고 이유를 상시 표시한다.
- 정렬은 `Intl.Collator('ko')` 로 가나다순. 로케일 없는 `localeCompare` 는 엔진마다 다르다.
  이름을 못 받은 종목은 코드로 섞지 않고 뒤에 몰아 둔다. 정렬·필터 **기능**은 나중이지만,
  이름을 `symbols.name` 에 저장해 두므로 서버로 내려갈 준비가 된다.

### 제거

참조 중인 종목은 영향받는 데이터셋을 나열하고 확인받은 뒤 참조까지 끊는다. 데이터셋이
빈 껍데기가 되는 경우는 막고 이유를 말한다. 과거 백테스트 결과가 재현 불가가 된다는
경고도 함께 낸다.

### 데이터셋

카드의 「동기화」는 남기되 **종목 동기화로 위임**한다 — 참조 종목을 선택해 같은 종목
단위 경로를 실행한다. 실행 경로는 하나로 유지하면서 "이 데이터셋에 필요한 것 전부" 라는
편의를 잃지 않는다. 카드의 마지막 동기화는 참조 종목 중 **가장 오래된** 값을 쓴다 —
묵음은 가장 약한 고리가 정한다.

## 하지 않는 것

- 호환 마이그레이션. 파괴적으로 간다 (사용자 지시). 기존 DB·Parquet 는 버린다.
- 정렬·필터 UI. 지금은 가나다순 고정.
- 재무 충족도 판정. 있고 없음만 본다 (D-033 범위 유지).
- 어긋난 조합 차단. 배지로 보여 주고 제출은 서버 422 가 막는다 (D-033 남은 한계 유지).
