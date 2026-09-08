"""고정 후보의 집계·재실행·비용 스트레스로 최종 보고서와 그림을 만든다."""

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np



def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def export(root, docs):
    chosen_id = "cross-sectional-momentum__high_vol__nearby-a"
    reports = {name: read(docs / f"kr-{name}.json") for name in (
        "existing-development", "pullback-development", "liquid-development", "existing-validation",
        "existing-confirmation", "pullback-validation", "pullback-confirmation", "liquid-validation", "liquid-confirmation",
    )}
    for name, count in [("existing-development", 84), ("pullback-development", 12), ("liquid-development", 36)]:
        if len(reports[name]["runs"]) != count:
            raise ValueError(f"개발 결과가 불완전합니다: {name}")
    selected = [next(r for r in reports[f"liquid-{stage}"]["runs"] if r["id"] == chosen_id)
                for stage in ("development", "validation", "confirmation")]
    originals = [read(root / directory / f"{chosen_id}.json") for directory in
                 ("liquid-development-v2", "liquid-validation", "liquid-confirmation")]
    replay = read(root / "liquid-replay" / f"{chosen_id}.json")
    original = originals[-1]
    same = {k: v for k, v in replay.items() if k != "elapsedMs"} == {k: v for k, v in original.items() if k != "elapsedMs"}
    if not same:
        raise ValueError("동일 입력 재실행의 계산 결과가 다릅니다")
    stresses = [read(root / f"liquid-{name}" / f"{chosen_id}.json") for name in ("cost-2", "cost-4", "seed-7", "seed-42")]
    if any(r["status"] != "completed" for r in stresses):
        raise ValueError("비용·시드 검증이 완료되지 않았습니다")
    stress_summary = [{"costMultiplier": r["costMultiplier"], "seed": r["seed"],
                       "returnPct": r["metrics"]["totalReturnPct"], "drawdownPct": r["metrics"]["maxDrawdownPct"],
                       "matchedNdxKrwPct": r["comparison"]["activeNdxKrwPct"],
                       "excessPp": r["comparison"]["activeExcessPp"]} for r in stresses]

    directories = ["development", "development-v2", "pullback-development", "liquid-development", "liquid-development-v2",
                   "existing-validation", "existing-confirmation", "pullback-validation", "pullback-confirmation",
                   "liquid-validation", "liquid-confirmation", "liquid-cost-2", "liquid-cost-4", "liquid-seed-7",
                   "liquid-seed-42", "liquid-replay"]
    inventory = {}
    artifacts = {}
    for directory in directories:
        files = sorted((root / directory).glob("*.json"))
        values = [read(f) for f in files]
        inventory[directory] = {"runs": len(values), "completed": sum(v["status"] == "completed" for v in values),
                                "failed": sum(v["status"] != "completed" for v in values)}
        for file in files:
            artifacts[str(file.relative_to(root))] = digest(file)
    inputs = [root / name for name in ("input-50.json.gz", "input-100.json.gz", "execution-overrides.json",
                                      "vix.csv", "bok.html", "kospi.xml", "047810.xml", "liquid-trials.json",
                                      "liquid-momentum-followup.json", "liquid-momentum-20-frozen.json")]
    code = sorted(Path("scripts/research").glob("*.py")) + sorted(Path("scripts/research").glob("*.ts"))
    engine = [Path("src/server/modules/backtest/domain/engine.ts"), Path("src/server/modules/backtest/domain/execution.ts"),
              Path("src/server/modules/backtest/domain/cost-profiles.ts")]
    evidence = {"status": "NO_VALIDATED_STRATEGY", "validDevelopmentConfigurations": 132,
                "inventory": inventory, "sameInputReplayEqualExceptElapsedMs": same,
                "comparison": selected, "stresses": stress_summary,
                "inputHashes": {str(f.relative_to(root)): digest(f) for f in inputs},
                "codeHashes": {str(f): digest(f) for f in [*code, *engine]},
                "resultHashes": artifacts,
                "baseCommit": "535c4d7", "engineVersion": original["engineVersion"],
                "notes": ["마지막 확인 구간도 이전 연구에서 다른 전략 성과를 본 기간이다.",
                          "20봉 후보는 기본값 중심 사전 선택 기준에 통과하지 못한 추가 탐색 후보다.",
                          "개발 구간의 206640 가격단위 변경은 독립 차트에서 추정했으며 권리 인증을 끝내지 않았다."]}
    (docs / "kr-regime-verification.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")

    fig, axes = plt.subplots(1, 3, figsize=(13.5, 4.4), sharey=True)
    for axis, run, title in zip(axes, originals, ("Development: 2016-2019", "Validation: 2020-2022", "Final check: 2023-Aug 2026")):
        rows = run["comparison"]["rows"]
        strategy = np.cumprod([1 + r["strategy"] for r in rows]) * 100
        benchmark = np.cumprod([1 + r["ndxKrw"] if r["active"] else 1 for r in rows]) * 100
        dates = np.array([np.datetime64(r["date"]) for r in rows])
        axis.plot(dates, strategy, color="#176d9c", linewidth=1.9, label="Korean 20-day momentum")
        axis.plot(dates, benchmark, color="#cf7b24", linewidth=1.6, label="NDX KRW, matched windows")
        axis.axhline(100, color="#aaaaaa", linewidth=.6)
        axis.grid(alpha=.2)
        axis.set_title(title, fontsize=11)
        axis.tick_params(axis="x", rotation=25)
    axes[0].set_ylabel("Initial capital = 100")
    axes[0].legend(fontsize=8, loc="lower left")
    fig.suptitle("Development outperformance did not persist", fontsize=15)
    fig.text(.5, .015, "Research diagnostic | Strategy after modeled costs | Cash outside windows | Price returns, not total returns",
             ha="center", fontsize=9, color="#555555")
    fig.tight_layout(rect=(0, .06, 1, .94))
    assets = docs / "assets"
    assets.mkdir(exist_ok=True)
    fig.savefig(assets / "kr-regime-validation.png", dpi=170)
    plt.close(fig)

    table = []
    for label, run in zip(("개발 2016–2019", "검증 2020–2022", "마지막 2023–2026-08-28"), selected):
        m, c = run["metrics"], run["comparison"]
        table.append(f"| {label} | {m['totalReturnPct']:+.2f}% | {c['activeNdxKrwPct']:+.2f}% | {c['activeNdxUsdPct']:+.2f}% | {m['maxDrawdownPct']:.2f}% | {c['activeDays']}일 / {c['episodes']}회 | {run['closedPositionCount']} |")
    stress_rows = [f"| 비용 {r['costMultiplier']}배 / 시드 {r['seed']} | {r['returnPct']:+.2f}% | {r['matchedNdxKrwPct']:+.2f}% | {r['drawdownPct']:.2f}% |" for r in stress_summary]
    new = reports["pullback-validation"]["runs"][0]
    new_cost = sum(new["metrics"][key] for key in ("totalCommission", "totalTax", "totalSlippage"))
    report = f"""# 국내 단기 국면 전략 연구 — 검증 목표 미달

2026-09-08, **동기간 원화 나스닥 100을 반복해서 앞서는 검증 통과 전략을 찾지 못했다.** 기존 전략 7개와 파라미터 변형을 먼저 탐색했고, 새 전략 `trend-pullback` 하나도 구현·검증했다. 새 전략은 연구 CLI로 실행할 수 있으며 운영 전략 목록에는 등록하지 않았다.

## 무엇을 비교했나

현재 보존된 KRX 일봉 6,580,591행과 과거 종목 이력을 사용했다. 추가로 [Cboe VIX API](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv), [한국은행 기준금리 이력](https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200643), Npay KOSPI 일별 API를 확보했다. 나스닥과 환율은 기존에 저장된 [FRED NASDAQ100](https://fred.stlouisfed.org/series/NASDAQ100)·[DEXKOUS](https://fred.stlouisfed.org/series/DEXKOUS) 원문을 썼다.

일봉에서 수일~수주 보유하는 매수 전용 전략이다. 국면은 **VIX ≥25, 한국 기준금리 ≤1.25%, KOSPI >60일 평균, VIX ≥25이면서 KOSPI >60일 평균**으로 고정했다. 시장 국면 밖에는 현금으로 대기하며 청산 지연일까지 양쪽 수익률에 포함했다.

시가총액 상위 50개(과거 합집합 123종목)에서 기존 84개와 새 전략 12개 조합을 실행했다. 이어 당시 거래대금 상위 100개(과거 합집합 1,521종목)에서 돌파·단기 모멘텀·새 전략 36개를 추가했다. **유효한 개발 조합 합계는 132개**다. 초기 리밸런싱 일정 오류 84회(36회 계산 완료·48회 거절), 거래정지 보강 전 36회 거절도 [실행 이력](kr-regime-verification.json)에 별도 보존했다. 서로 독립인 132개 표본이라는 뜻은 아니다.

초기 현금 1억원, 최대 5종목, 신호 종가 기준 종목당 20%, 기존 전략 공통 보유 상한 20거래일이다. 종가 신호는 다음 거래 가능일 시가에 체결했다. 날짜별 매도세, 편도 수수료 1.5bp, 슬리피지 5bp와 KRX 호가, 직전 거래량 1% 체결 한도를 반영했다. 세금·호가 때문에 단순히 왕복 13bp만 드는 모형이 아니다.

## 개발 구간에서 좋아 보였던 기존 전략

거래대금 상위 100개 중 **직전 20거래일 상승률 상위 5개를 보유하는 횡단면 모멘텀**이다. 최근 제외 기간 0일, 양의 모멘텀만 허용하고 5거래일마다 재평가한다. VIX가 직전 미국 거래일 25 이상일 때만 진입한다. 다른 설정은 위 공통 조건을 따른다.

40봉 기본값은 개발 구간에서 벤치마크를 넘지 못했다. 20봉은 더 좋아 보여 후속 평가 전에 추가 탐색 후보로 고정했다. **최초 기본값 중심 선택 기준의 통과 후보가 아니다.** 개발 구간의 고유 청산 포지션도 29개로 30개 기준에 못 미쳤으며, 206640의 2016-02-12 가격단위 보정을 보유 중 통과해 데이터 인증도 남았다.

| 구간 | 전략 순수익 | 같은 구간 NDX 원화 | 같은 구간 NDX 달러 | 전략 최대 낙폭 | 비교 일수 / 연속 국면 수 | 고유 청산 포지션 |
|---|---:|---:|---:|---:|---:|---:|
{chr(10).join(table)}

보유기간은 각 구간의 실제 거래일로 계산했다. 위 수익률은 해당 국면과 실제 청산 지연 기간을 모두 누적한 값이며, 좋은 거래만 골라낸 값이 아니다. 청산 지연이 다르면 변형별 비교 일수와 NDX 수익률도 달라질 수 있다. 전체 달력 기간의 현금 포함 전략과 상시 보유 NDX 성과는 JSON의 `fullNdxKrwPct`에서 따로 확인할 수 있다. 2023년 이후 전체 NDX 원화 수익은 약 +196.98%다. 표의 국면 비교를 상시 투자한 지수를 이긴 결과로 읽으면 안 된다.

![고정 모멘텀 후보와 같은 비교 구간의 원화 NDX](assets/kr-regime-validation.png)

20·40·60봉을 모두 같은 후속 구간에서 계산했다. 2020–2022 순수익은 각각 -40.11%, -24.12%, -53.29%, 마지막 구간은 +2.45%, -24.74%, -13.68%였다. 후속 성과를 보고 다른 봉 수로 갈아타지 않았다. 처음 50종목에서 고른 EMA 고변동성 진단 후보도 중간 -25.32%, 마지막 +3.89%로 같은 국면 NDX를 밑돌았다.

## 새로 만든 전략

[`trend-pullback.ts`](../../scripts/research/trend-pullback.ts)는 **60일 평균 위 종목의 RSI(2) 과매도**를 매수하는 전략이다. RSI가 낮은 종목부터 최대 5개를 고르고, RSI 60 회복·실제 진입가 기준 ATR(14) 2배 손절·5거래일 보유 중 먼저 오는 조건에서 다음 시가에 청산한다. 진입 RSI는 5·10·15를 비교했으며 10이 기본값이다. 분할 때 RSI·ATR·이동평균과 손절 가격을 함께 보정한다.

새 전략도 개발 구간의 가족 선택 기준을 만족하지 못했다. 거래 수가 충분한 저금리 기본값을 진단용으로 고정했을 때, 2020–2022에는 **{new['metrics']['totalReturnPct']:+.2f}% 대 NDX 원화 {new['comparison']['activeNdxKrwPct']:+.2f}%**, 최대 낙폭 {new['metrics']['maxDrawdownPct']:.2f}%였다. 평균 보유는 {new['averageHoldingBars']:.2f}거래일, 청산은 {new['closedPositionCount']}개였다. 수수료·매도세·호가를 포함한 슬리피지의 거래기록상 합계가 약 {new_cost / 1e6:.2f}백만원이었다. 이 금액을 더하면 무비용 전략 수익률이 된다는 뜻은 아니다. 비용이 바뀌면 후속 수량과 체결 경로도 달라진다.

2023년 이후에는 기준금리 ≤1.25%인 날이 없어 새 전략의 해당 국면 재검증이 불가능했다. 현금 0% 수익을 검증 성공으로 세지 않았다. 고변동성·국내 상승 추세 조합도 개발 구간에 표본이 없어 신뢰할 후보로 채택하지 않았다.

## 비용·재현성과 한계

추가 탐색의 20봉 모멘텀을 마지막 구간에서 고정한 결과다. 비용 배수는 수수료·슬리피지에 적용하고 법정 매도세는 그대로 뒀다.

| 조건 | 전략 순수익 | 같은 구간 NDX 원화 | 최대 낙폭 |
|---|---:|---:|---:|
{chr(10).join(stress_rows)}

같은 입력·시드·비용으로 다시 실행한 **모든 지표·자산·체결·거래·경고·보유 내역이 계산 시간 필드만 제외하고 일치**했다. 실행 검증은 정적 검사, 타입 검사, 전체 TypeScript 테스트 1,977개, 연구용 Python 테스트 3개, 서버·웹 빌드를 통과했다. 웹 변경이 없어 브라우저 E2E는 추가 실행하지 않았다. 기존 웹 번들의 크기 경고는 남아 있다.

가격·거래정지·공시 데이터의 한계도 결과에 포함했다. 거래대금 종목군에서 047810의 2017-10-11 가격 공백을 발견했다. 추가 Npay API에서 시가·고가·저가가 0(종가 47,700, 거래량 141)인 것을 확인했고, [당시 거래정지 보도](https://www.seoul.co.kr/news/economy/2017/10/11/20171011500057)와 대조해 그 날의 체결을 금지했다. 가격 봉을 만들어 채우지는 않았다. 실제 원문과 보강 파일의 해시는 검증 JSON에 있다.

추정 가격단위 변경을 완전한 권리 처리로 간주하지 않았다. 현금배당, 합병·신주 권리, 신주 실제 매도 가능일, 작은 미확인 권리 및 최초 공시 원본의 완전성은 남은 한계다. 추정·미해결 기업행위를 보유 중 통과한 결과는 검증 통과로 인정하지 않는다. 재무 전략의 적은 거래는 부족한 TTM 공시 이력의 영향도 있으므로 전략 자체가 무효라는 증거가 아니다.

미국 지수·VIX·환율은 한국 장에 앞선 관측일로 맞췄다. 이는 일봉 기준의 관측 시점 정렬이며 분봉으로 양국의 정확히 같은 체결 시각을 비교한 결과는 아니다. 지수 가격수익을 비교했고 현금 이자는 0, 국내 현금배당 제외, 투자자별 소득과세 전이다. 이전 연구에서 다른 전략으로 이 시장 기간 전체를 보았으므로 마지막 구간도 완전히 새로운 블라인드 표본이 아니다. JSON의 짝지은 20일 블록 재표본은 과거 경로에 조건부인 불확실성 진단이다.

이번 결과는 **이 탐색에서 우월성이 재현되지 않았다는 결론**이며 모든 가능한 국내 단기 전략이 불가능하다는 증명은 아니다. 수익성 검증에 실패한 새 전략을 운영 후보로 승격하지 않았다.

## 재현 자료

- [실행 방법과 입력 설명](../../scripts/research/README.md)
- [최초 프로토콜](kr-regime-protocol.md), [새 전략 규칙](kr-pullback-protocol.md), [거래대금 확장](kr-liquid-universe-protocol.md), [20봉 추가 검증 규칙](kr-momentum-followup-protocol.md)
- [기존 84개 결과](kr-existing-development.json), [새 전략 12개 결과](kr-pullback-development.json), [확장 36개 결과](kr-liquid-development.json)
- [추가 후보 중간 검증](kr-liquid-validation.json), [마지막 확인](kr-liquid-confirmation.json), [원문·결과 해시와 재실행 검증](kr-regime-verification.json)

원문·입력·전체 개별 거래내역은 Git 제외 로컬 `data/kr-regime-research/`에 보존했다. 공개 저장소에는 코드·설정·집계 결과·그림만 포함한다.
"""
    (docs / "kr-regime-report.md").write_text(report)
    print(json.dumps({"report": str(docs / "kr-regime-report.md"), "replayEqual": same,
                      "physicalEngineRuns": sum(v["runs"] for v in inventory.values()), "stresses": stress_summary}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("docs", type=Path)
    args = parser.parse_args()
    export(args.root, args.docs)
