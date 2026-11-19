# 설정 탐색 API

설정 탐색은 종료된 원본 백테스트의 전략과 기간을 유지하면서 설정 조합을 무작위로 추출해 별도 자식 백테스트를 실행합니다. 원본 기록은 변경하지 않습니다. 미리보기와 실행은 별도 단계입니다. 실행을 시작하면 필요한 최신 데이터를 준비하므로 원본과 데이터 버전이 다를 수 있습니다. 추천 범위는 탐색 시작점이며 성과를 보장하지 않습니다.

## 인증 및 발견

설정 → API 명세 (`/settings/api-reference`)에서 전체 API의 인증, 요청 및 응답 계약을 조회할 수 있습니다. 명세 페이지에는 요청 실행 기능이 없습니다. 설정에서 OpenAPI 토큰을 발급하고 로컬 도구의 비밀 환경 변수 `QUANT_API_TOKEN`에 보관하세요. 기본 유효기간은 365일이며, 실행에는 `READ_WRITE` 권한이 필요합니다. 토큰 원문은 발급 시 한 번만 표시됩니다. 발급·폐기는 로그인한 브라우저 세션에서만 가능합니다.

일반 API는 로그인 세션 또는 `Authorization: Bearer <token>`을 받습니다. 다음 예시는 환경 변수의 토큰을 사용합니다. 실제 토큰을 코드나 저장소에 기록하지 마세요.

```sh
curl -H "Authorization: Bearer $QUANT_API_TOKEN" https://example.test/api/v1/system/api-reference
curl -H "Authorization: Bearer $QUANT_API_TOKEN" https://example.test/api/v1/backtests/SOURCE_ID/configuration-search/catalog
curl -H "Authorization: Bearer $QUANT_API_TOKEN" https://example.test/api/v1/intraday/runs/SOURCE_ID/configuration-search/catalog
```

원본별 `catalog.fields`는 허용 키, 현재값, 종류, 숫자 범위·간격 또는 선택지, 선택 가능한 미설정 값과 추천 범위를 제공합니다. 일봉과 분봉의 필드는 다르며 분봉에는 유니버스와 난수 시드가 없습니다. 도구나 자동화는 고정된 키 목록을 가정하지 말고 해당 원본의 카탈로그를 조회해야 합니다.

## 미리보기와 실행

일봉 전고점 돌파 전략의 예시입니다. 실제 원본의 카탈로그에 표시된 키와 범위로 바꾸고, 새 요청마다 UUID를 생성하세요. 아래 내용을 `preview.json`에 저장합니다.

```json
{
  "requestId": "123e4567-e89b-42d3-a456-426614174000",
  "config": {
    "count": 2,
    "settings": {
      "parameters.lookbackBars": { "kind": "RANGE", "min": 10, "max": 20 },
      "execution.slippageProfileId": { "kind": "CHOICE", "values": ["fixed-5bps", "zero-slippage"] }
    }
  }
}
```

```sh
curl -H "Authorization: Bearer $QUANT_API_TOKEN" -H 'Content-Type: application/json' \
  --data @preview.json https://example.test/api/v1/backtests/SOURCE_ID/configuration-search/preview
```

분봉에서는 `/intraday/runs/SOURCE_ID/configuration-search/preview`를 사용합니다. `count`는 1~100이며 `settings`에서 생략한 설정은 원본 값으로 고정됩니다. 숫자는 카탈로그의 간격에 맞춰 유한한 값으로 지정하고, 허용된 선택형 숫자 필드에서는 `includeUnset: true`로 미설정도 후보에 포함할 수 있습니다. 여러 설정의 제약 때문에 범위 안의 모든 조합이 유효한 것은 아닙니다. 요청한 수만큼 서로 다른 유효 조합이 없으면 422를 반환합니다.

응답 `experiment.id`와 `items`에는 영속 저장된 실제 조합이 들어 있습니다. 같은 사용자, 같은 `requestId`와 같은 본문으로 다시 요청하면 같은 미리보기를 반환합니다. 같은 UUID를 다른 본문이나 원본에 사용하면 409입니다. 미리보기는 실행하지 않습니다. 내용을 확인한 뒤 명시적으로 시작합니다.

일봉 시장 탐색은 기존 키 `universeRule.markets.0`을 사용하며 `KOSPI+KOSDAQ`, `KOSPI`, `KOSDAQ` 중에서 선택합니다. 이 키는 시장 배열 전체를 바꿉니다. 예를 들어 `KOSPI+KOSDAQ`은 `["KOSPI", "KOSDAQ"]`, `KOSDAQ`은 `["KOSDAQ"]`으로 실행됩니다. 시장 설정을 생략하면 원본의 시장 배열을 그대로 유지합니다.

```sh
curl -H "Authorization: Bearer $QUANT_API_TOKEN" -X POST https://example.test/api/v1/configuration-searches/SEARCH_ID/start
curl -H "Authorization: Bearer $QUANT_API_TOKEN" https://example.test/api/v1/configuration-searches/SEARCH_ID
```

같은 실험의 시작을 재요청해도 자식을 다시 만들지 않습니다. 실행 코드나 전략 버전이 미리보기 이후 바뀌었다면 새 미리보기가 필요합니다. 동시에 실행·취소 중인 실험은 전체 최대 5개이며 사용자당 미시작 미리보기는 최대 100개입니다. 한도에 도달하면 409를 반환합니다.

## 조회, 취소, 삭제

- `GET /backtests/SOURCE_ID/configuration-search` 또는 `GET /intraday/runs/SOURCE_ID/configuration-search`: 미시작 미리보기를 포함한 실험 목록. 목록에서 미리보기 ID를 찾아 조회, 시작 또는 삭제할 수 있습니다.
- `GET /configuration-searches/SEARCH_ID`: 상태, 조합, 자식 상태, 성과와 `resultHref`를 조회합니다. 원본 링크는 `sourceHref`입니다.
- `POST /configuration-searches/SEARCH_ID/cancel`: 대기 항목과 실행 중 자식의 취소를 요청합니다. 실행 중 작업이 종료될 때까지 `CANCELLING`일 수 있습니다.
- `DELETE /configuration-searches/SEARCH_ID`: 미시작 또는 종료된 실험을 삭제합니다. **연결된 자식 백테스트와 그 결과도 삭제됩니다.** 실행 중인 자식이 있으면 삭제할 수 없습니다.

실험 상세와 분봉 원본은 소유자별로 접근이 제한됩니다. 상태와 오류를 확인하고 삭제 전에 필요한 결과를 보존하세요.
