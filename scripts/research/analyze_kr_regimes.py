"""탐색 결과를 같은 관측구간으로 재집계하고 고정한 가족 선택·검증 기준을 적용한다."""

import argparse
from collections import defaultdict
import gzip
import json
from pathlib import Path

import numpy as np


def timestamp(date):
    return int(np.datetime64(date, "ms").astype(np.int64))


def compare(result, macro):
    """국면 종료 뒤 지연 청산일까지 포함해 매매 손익을 누락하지 않는다."""
    equity = {p["tsMs"]: p["equity"] for p in result["equity"]}
    regime, start, end = result["candidate"]["regime"], result["from"], result["to"]
    holding = set()
    dates = np.array([r["date"] for r in macro])
    times = np.array([timestamp(d) for d in dates])
    for trade in result["trades"]:
        holding.update(np.flatnonzero((times >= trade["entryTsMs"]) & (times <= trade["exitTsMs"])).tolist())
    for position in result["openPositions"]:
        holding.update(np.flatnonzero(times >= position["entryTsMs"]).tolist())
    rows, prior_equity, was_active, episodes = [], result["metrics"]["initialCash"], False, 0
    for i, point in enumerate(macro):
        if i == 0 or point["date"] < start or point["date"] > end:
            continue
        current_equity = equity[times[i]]
        prior = macro[i - 1]
        active = (prior["date"] >= start and prior["regimes"][regime]) or i in holding
        if i >= 2:
            active |= macro[i - 2]["date"] >= start and macro[i - 2]["regimes"][regime]
        episodes += int(active and not was_active)
        first = not rows
        rows.append({"date": point["date"], "strategy": current_equity / prior_equity - 1,
                     "ndxKrw": 0 if first else point["ndxKrw"] / prior["ndxKrw"] - 1,
                     "ndxUsd": 0 if first else point["ndxUsd"] / prior["ndxUsd"] - 1, "active": bool(active)})
        was_active, prior_equity = active, current_equity
    active_rows = [r for r in rows if r["active"]]
    growth = lambda rs, field: float(np.prod([1 + r[field] for r in rs]) - 1) * 100
    outside_return = growth([r for r in rows if not r["active"]], "strategy")
    if abs(outside_return) > 1e-7:
        raise ValueError(f"비교 구간 밖 손익이 남았습니다: {result['id']}: {outside_return}")
    return {"activeDays": len(active_rows), "episodes": episodes,
            "activeStrategyPct": growth(active_rows, "strategy"),
            "activeNdxKrwPct": growth(active_rows, "ndxKrw"), "activeNdxUsdPct": growth(active_rows, "ndxUsd"),
            "activeExcessPp": growth(active_rows, "strategy") - growth(active_rows, "ndxKrw"),
            "fullNdxKrwPct": growth(rows, "ndxKrw"), "fullNdxUsdPct": growth(rows, "ndxUsd"), "rows": rows}


def gates(result):
    if result["status"] != "completed":
        return {"engineCompleted": False}
    return {
        "positiveNetReturn": result["metrics"]["totalReturnPct"] > 0,
        "beatsMatchedNdxKrw": result["comparison"]["activeExcessPp"] > 0,
        "atLeast30Trades": len({(t["symbol"], t["entryTsMs"]) for t in result["trades"]}) >= 30,
        "drawdownWithin25Pct": abs(result["metrics"]["maxDrawdownPct"]) <= 25,
        "averageHoldingWithin20Bars": 0 < (result["averageHoldingBars"] or 0) <= 20,
        "noUnresolvedHeldActions": not result["affectedActions"],
        "noOpenPositions": not result["openPositions"],
        "noUnverifiedInferredHeldActions": not result.get("inferredHeldActions", []),
    }


def compact(result):
    if result["status"] != "completed":
        return {k: result[k] for k in ("id", "stage", "status", "error", "candidate")}
    return {"id": result["id"], "stage": result["stage"], "status": result["status"],
            "candidate": result["candidate"], "parameters": result["parameters"],
            "metrics": result["metrics"], "closedPositionCount": len({(t["symbol"], t["entryTsMs"]) for t in result["trades"]}), "comparison": {k: v for k, v in result["comparison"].items() if k != "rows"},
            "averageHoldingBars": result["averageHoldingBars"], "maxHoldingBars": result["maxHoldingBars"],
            "affectedActions": result["affectedActions"], "inferredHeldActions": result.get("inferredHeldActions", []), "gates": gates(result)}


def bootstrap(result, samples=5000, block=20):
    """국면 밖 현금까지 보존한 짝지은 블록 재표본이며 미래 승률이 아니다."""
    rows = result["comparison"]["rows"]
    values = np.array([[np.log1p(r["strategy"]), np.log1p(r["ndxKrw"]) if r["active"] else 0] for r in rows])
    rng = np.random.default_rng(204)
    indexes = (rng.integers(0, len(rows), (samples, int(np.ceil(len(rows) / block)), 1)) + np.arange(block)) % len(rows)
    indexes = indexes.reshape(samples, -1)[:, :len(rows)]
    differences = values[indexes].sum(axis=1)
    annual_excess = (np.exp(differences[:, 0] * 252 / len(rows)) - np.exp(differences[:, 1] * 252 / len(rows))) * 100
    return {"samples": samples, "blockTradingDays": block,
            "annualizedMatchedExcess95Pct": np.quantile(annual_excess, [.025, .975]).tolist(),
            "positiveHistoricalResampleFraction": float((annual_excess > 0).mean())}


def analyze(input_path, directory, destination, select):
    with gzip.open(input_path, "rt") as stream:
        data = json.load(stream)
    results = [json.loads(p.read_text()) for p in sorted(directory.glob("*.json"))]
    for result in results:
        if result["status"] == "completed":
            result["comparison"] = compare(result, data["macro"])
            result["inferredHeldActions"] = [a for a in data["metadata"]["correctedUnitChanges"]
                if any(t["symbol"] == a["key"] and t["entryTsMs"] < timestamp(a["periodKey"]) <= t["exitTsMs"]
                       for t in result["trades"])]
    destination.parent.mkdir(parents=True, exist_ok=True)
    report = {"runs": [compact(r) for r in results]}
    if select:
        groups = defaultdict(list)
        for r in results:
            if r["status"] == "completed":
                groups[(r["candidate"]["strategyId"], r["candidate"]["regime"])].append(r)
        ranked = []
        for (strategy, regime), members in groups.items():
            base = next((r for r in members if r["candidate"]["variant"] == "base"), None)
            if base is None or len(members) != 3:
                continue
            enough_trades = all(gates(r)["atLeast30Trades"] for r in members)
            median_excess = float(np.median([r["comparison"]["activeExcessPp"] for r in members]))
            ranked.append({"strategy": strategy, "regime": regime, "medianExcessPp": median_excess,
                           "enoughTradesInAllVariants": enough_trades, "baseGates": gates(base), "baseCandidate": base["candidate"]})
        ranked.sort(key=lambda r: r["medianExcessPp"], reverse=True)
        qualified = [r for r in ranked if r["enoughTradesInAllVariants"] and r["medianExcessPp"] > 0 and all(r["baseGates"].values())]
        report["rankedFamilies"] = ranked
        report["selected"] = [qualified[0]["baseCandidate"]] if qualified else []
        # 적격이 없어도 거래가 있는 최상위 기본값 하나의 실패를 후속 구간에서 확인한다.
        diagnostic = [r for r in ranked if r["enoughTradesInAllVariants"]]
        report["diagnostic"] = [diagnostic[0]["baseCandidate"]] if diagnostic else []
        destination.with_suffix(".selection.json").write_text(json.dumps(report["selected"], indent=2) + "\n")
        destination.with_suffix(".diagnostic.json").write_text(json.dumps(report["diagnostic"], indent=2) + "\n")
    else:
        report["uncertainty"] = {r["id"]: bootstrap(r) for r in results if r["status"] == "completed" and r["comparison"]["activeDays"] > 0}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"runs": len(results), "qualified": report.get("selected"), "diagnostic": report.get("diagnostic"),
                      "completed": sum(r["status"] == "completed" for r in results)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--select", action="store_true")
    args = parser.parse_args()
    analyze(args.input, args.directory, args.destination, args.select)
