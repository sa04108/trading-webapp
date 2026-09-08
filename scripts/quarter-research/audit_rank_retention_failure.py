"""최대 손실 전환 사례를 실제 체결의 종목별 순현금과 청산 시점으로 분해한다."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(source, output):
    case = next(r for r in json.loads(source.read_text()) if r["selection"] == "largestReturnDecrease")
    runs, originals = {}, {}
    for label in ("base", "neighbor"):
        path = Path(case[label]["file"])
        require(digest(path) == case[label]["sha256"], "보존된 원본 계좌 해시 불일치")
        run = json.loads(path.read_text())
        require(run["risk"]["initialCash"] == 100_000_000 and run["summary"]["closed"] and not run["summary"]["affectedActions"],
                "이 분해는 원래 현금·전량 청산·기업행위 조건을 충족해야 합니다")
        require(not any(e["reason"] == "실제 목표 미달 후 재개" for e in run["summary"]["riskEvents"]), "재개 계좌는 이 분해의 범위 밖입니다")
        originals[label] = run
        by_symbol = {}
        for fill in run["result"]["fills"]:
            by_symbol.setdefault(fill["symbol"], []).append(fill)
        rows = []
        for symbol, fills in sorted(by_symbol.items()):
            buys = [f for f in fills if f["side"] == "BUY"]
            sells = [f for f in fills if f["side"] == "SELL"]
            require(len(buys) == len(sells) == 1 and buys[0]["quantity"] == sells[0]["quantity"], "단일 매수·전량 매도 조건 불일치")
            pnl = sum((1 if f["side"] == "SELL" else -1) * f["grossAmount"] - f["commission"] - f["tax"] for f in fills)
            rows.append({"symbol": symbol, "netPnlKrw": pnl, "accountReturnContributionPct": pnl / 1_000_000, "buy": buys[0], "sell": sells[0]})
        require(math.isclose(sum(r["netPnlKrw"] for r in rows), run["summary"]["returnPct"] * 1_000_000, abs_tol=.01), "체결 순현금과 계좌 수익 불일치")
        runs[label] = {"path": str(path), "sha256": digest(path), "rows": rows, "returnPct": run["summary"]["returnPct"], "riskEvents": run["summary"]["riskEvents"]}
    base, neighbor = originals["base"], originals["neighbor"]
    require(all(base[k] == neighbor[k] for k in ("inputSha256", "optionsSha256", "risk", "seed", "slippageBps")), "파라미터 이외의 원문·위험·실행 설정 차이")
    require(all(base["summary"][k] == neighbor["summary"][k] for k in ("start", "end", "startState")), "시작 조건·평가 기간 차이")
    common = {r["symbol"] for r in runs["base"]["rows"]} & {r["symbol"] for r in runs["neighbor"]["rows"]}
    require(len(common) == 3 and all(len(v["rows"]) == 5 for v in runs.values()), "보존된 최초 세 종목 공통·두 종목 교체 조건 불일치")
    for symbol in common:
        buys = [next(r for r in v["rows"] if r["symbol"] == symbol)["buy"] for v in runs.values()]
        require(buys[0] == buys[1], "공통 종목의 최초 매수 체결이 다릅니다")
    components = {}
    for label, keep_common in (("common", True), ("replaced", False)):
        amounts = {k: sum(r["netPnlKrw"] for r in v["rows"] if (r["symbol"] in common) == keep_common) for k, v in runs.items()}
        components[label] = amounts | {"deltaKrw": amounts["neighbor"] - amounts["base"]}
    require(math.isclose(sum(c["deltaKrw"] for c in components.values()) / 1_000_000, case["paired"]["returnDeltaPctPoints"], abs_tol=1e-8),
            "공통·교체 종목의 합계와 계좌 수익 차이 불일치")
    dates = {e["date"] for v in runs.values() for e in v["riskEvents"]}
    dates.update(datetime.fromtimestamp(r["sell"]["tsMs"] / 1000, timezone.utc).strftime("%Y-%m-%d") for v in runs.values() for r in v["rows"])
    checkpoints = []
    for day in sorted(dates):
        ts = int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000)
        checkpoints.append({"date": day, **{k: next(p["equity"] for p in v["result"]["equityPoints"] if p["tsMs"] == ts) for k, v in originals.items()}})
    result = {"asof": "2026-09-08", "baseCommit": "b77cbf0", "caseSelection": "largestReturnDecrease",
              "sourceSha256": {str(source): digest(source)}, "codeSha256": {str(Path(__file__)): digest(Path(__file__))},
              "start": case["paired"]["start"], "end": case["paired"]["end"], "commonSymbols": sorted(common),
              "components": components, "checkpoints": checkpoints, "runs": runs,
              "note": "동일 날짜 두 모형 계좌의 사후 손익 분해다. 반사실적 인과 효과나 새 후보 성과가 아니다. 슬리피지는 체결 총액에 반영되어 현금에서 이중 차감하지 않는다."}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"common": sorted(common), "components": components, "checkpoints": checkpoints}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    audit(args.source, args.output)
