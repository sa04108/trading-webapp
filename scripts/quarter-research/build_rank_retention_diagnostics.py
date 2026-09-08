"""고정한 보유 유지 후보의 실행·비용·환경과 모든 같은 날짜 계좌를 대조한다."""

import argparse
import csv
from datetime import datetime, timezone
import gzip
import math
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify
from build_execution_evidence import passes
from build_target_retry_evidence import audit


def maturity_volume_audit(records):
    """미청산 계좌의 마지막 실제 매도를 원문 거래량 한도와 대조한다."""
    audited = []
    day = lambda ts: datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d")
    for input_name in sorted({r["input"] for r in records}):
        relevant = [r for r in records if r["input"] == input_name]
        symbols = {p["symbol"] for r in relevant for p in r["openPositions"]}
        data = json.loads(gzip.decompress(Path(input_name).read_bytes()))
        histories = {s: sorted([c for c in data["candles"] if c["symbol"] == s], key=lambda c: c["tsMs"]) for s in symbols}
        facts = [f for f in data.get("facts", []) if f["field"] == "SPLIT_RATIO" and f["key"] in symbols]
        del data
        for r in relevant:
            run = json.loads(Path(r["file"]).read_text())
            for position, sell in zip(r["openPositions"], r["lastSells"], strict=True):
                if sell is None or sell["reason"] != "3개월 만기 청산" or sell["tsMs"] != position["lastPriceTsMs"]:
                    raise ValueError("별도 원인 확인이 필요한 미청산 계좌입니다")
                bars = [c for c in histories[position["symbol"]] if c["tsMs"] <= sell["tsMs"]][-2:]
                if len(bars) != 2 or bars[-1]["tsMs"] != sell["tsMs"]:
                    raise ValueError("미청산 종목의 직전·마지막 실제 일봉이 없습니다")
                previous, final = bars
                if any(f["key"] == position["symbol"] and day(previous["tsMs"]) < f["periodKey"] <= day(final["tsMs"])
                       and f["asOfTsMs"] <= final["tsMs"] for f in facts):
                    raise ValueError("단위 변경이 있는 최종 매도 한도는 별도 확인이 필요합니다")
                limit = min(math.floor(previous["volume"] * .01), math.floor(final["volume"]))
                filled = sum(f["quantity"] for f in run["result"]["fills"] if f["symbol"] == position["symbol"] and f["tsMs"] == final["tsMs"])
                if filled != limit or position["quantity"] <= 0:
                    raise ValueError("미청산 잔량과 최종 실제 거래량 한도의 불일치")
                audited.append({k: r[k] for k in ("stage", "start", "end", "returnPct", "closed", "targetReached", "file", "sha256", "matchesBaselineResult")} | {
                    "symbol": position["symbol"], "remainingQuantity": position["quantity"], "previousVolume": previous["volume"], "finalVolume": final["volume"],
                    "finalTradingDate": day(final["tsMs"]), "lastSignalDate": day(r["lastSignalTsMs"]), "lastValuationDate": day(r["lastValuation"]["tsMs"]),
                    "finalSell": sell, "volumeLimitQuantity": limit})
    return audited


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path = cfg / "rank-retention-diagnostics-experiments.json"
    originals = [cfg / "target-retry-diagnostics-experiments.json", cfg / "target-retry-experiments.json"]
    candidate_path, baseline_path = cfg / "rank-retention-20.json", cfg / "account-stop-candidate.json"
    conditions_path = cfg / "account-stop-condition-dates.json"
    protocol = Path("docs/research/kr-current-quarter-rank-retention-diagnostics-protocol.md")
    experiments = json.loads(experiments_path.read_text())
    expected = []
    for original_path in originals:
        for e in json.loads(original_path.read_text()):
            if original_path == originals[1] and e["seed"] == 204 and e["rebalanceOffsetBars"] == 0:
                continue
            expected.append({"directory": "rank-retention-diagnostics/" + e["directory"].split("/")[-1],
                             "stage": e["stage"], "input": e["input"], "selection": candidate_path.name, "options": e["options"],
                             "slippageBps": e["slippageBps"], "seed": e["seed"], "rebalanceOffsetBars": e.get("rebalanceOffsetBars", 0),
                             "diagnostic": e.get("diagnostic", "execution"), "baseline": e["directory"], "baselineSelection": e["selection"]})
    if len(experiments) != 20 or experiments != expected:
        raise ValueError("이전 고정 실행 목록과 다른 후속 비교입니다")
    execution = {(e["seed"], e["rebalanceOffsetBars"], e["stage"]) for e in experiments if e["diagnostic"] == "execution"}
    if execution != {(seed, offset, stage) for seed, offset in ((204, 1), (204, 2), (204, 3), (204, 4), (205, 0), (206, 0)) for stage in ("validation", "confirmation")}:
        raise ValueError("실행 변화 조합이 고정 규칙과 다릅니다")
    candidate, base_candidate = json.loads(candidate_path.read_text()), json.loads(baseline_path.read_text())
    if (candidate != [{"id": "rank-retention-20", "strategyId": "rank-retention-momentum", "topN": 5, "rebalanceBars": 20,
                      "parameters": {"formationDays": 20, "skipDays": 0, "topN": 5, "retentionRank": 10}}]
            or base_candidate != [{"id": "momentum-20-5-monthly", "strategyId": "cross-sectional-momentum", "topN": 5,
                                   "rebalanceBars": 20, "parameters": {"formationDays": 20, "skipDays": 0, "topN": 5}}]):
        raise ValueError("고정 후보가 달라졌습니다")
    candidate, base_candidate = candidate[0], base_candidate[0]
    for stage in ("validation", "confirmation"):
        experiments.append({"directory": f"rank-retention/20-{stage}", "baseline": f"target-retry/seed204-offset0-{stage}",
                            "options": f"target-retry-seed204-offset0-{stage}-options.json", "stage": stage,
                            "input": "expanded/stock-200-verified-input.json.gz", "slippageBps": 5, "seed": 204,
                            "rebalanceOffsetBars": 0, "diagnostic": "primary", "reused": True})
    sources = {experiments_path, *originals, candidate_path, baseline_path, conditions_path, protocol}
    records, files, affected, unclosed = [], [], [], []
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    for e in experiments:
        options_path, input_path = cfg / e["options"], root / e["input"]
        options = json.loads(options_path.read_text())
        if (options.get("rebalanceOffsetBars", 0) != e["rebalanceOffsetBars"] or options["accountStopPct"] != 15
                or not options["resumeAfterMissedTarget"] or not options["resetUncertainHistory"]):
            raise ValueError("위험·이력·선정일 설정이 달라졌습니다")
        sources.update((options_path, input_path))
        base_windows, checked = verify(root, e["baseline"], base_candidate, e["stage"], options_path, input_path, 15, options["starts"],
                                       e["slippageBps"], e["seed"], strategy_version="2.2.1+history-reset.1+target-retry.1")
        files.extend(checked)
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, 15, options["starts"],
                                  e["slippageBps"], e["seed"], strategy_version="0.1.0+history-reset.1+target-retry.1",
                                  expected_parameters=candidate["parameters"] | {"absoluteMomentumFilter": True})
        files.extend(checked)
        pairs = []
        for w in windows:
            path = root / e["directory"] / f'{candidate["id"]}__{w["start"]}.json'
            base_path = root / e["baseline"] / f'{base_candidate["id"]}__{w["start"]}.json'
            run, base = json.loads(path.read_text()), json.loads(base_path.read_text())
            pair = audit(run, base, same_strategy=False)
            def first_buys(result):
                buys = [f for f in result["fills"] if f["side"] == "BUY"]
                return [f for f in buys if f["tsMs"] == buys[0]["tsMs"]] if buys else []
            if first_buys(run["result"]) != first_buys(base["result"]) or run["result"]["metrics"]["maxConcurrentPositions"] > 5:
                raise ValueError("최초 매수 또는 보유 수 상한이 다릅니다")
            pair["sameResult"] = run["result"] == base["result"]
            pairs.append(pair)
            detail = {k: e[k] for k in ("directory", "stage", "diagnostic", "slippageBps", "seed", "rebalanceOffsetBars")}
            detail.update({k: w[k] for k in fields})
            detail.update({"file": str(path), "sha256": digest(path), "input": str(input_path), "matchesBaselineResult": pair["sameResult"]})
            if w["affectedActions"] and not e.get("reused", False):
                affected.append(detail)
            if not w["closed"] and not e.get("reused", False):
                unclosed.append(detail | {"lastSignalTsMs": run["risk"]["lastSignalTsMs"], "openPositions": run["result"]["openPositions"],
                                          "lastValuation": run["result"]["equityPoints"][-1],
                                          "lastSells": [next((f for f in reversed(run["result"]["fills"]) if f["symbol"] == p["symbol"] and f["side"] == "SELL"), None)
                                                        for p in run["result"]["openPositions"]]})
        record = {k: e[k] for k in ("directory", "baseline", "stage", "diagnostic", "slippageBps", "seed", "rebalanceOffsetBars")}
        record.update({"reused": e.get("reused", False), "baseAll": summarize(base_windows), "baseNonoverlapping": summarize(nonoverlapping(base_windows)),
                       "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows, "baseWindows": base_windows, "paired": pairs,
                       "failureToSuccess": sum(not p["baseTargetReached"] and p["targetReached"] for p in pairs),
                       "successToFailure": sum(p["baseTargetReached"] and not p["targetReached"] for p in pairs),
                       "returnImproved": sum(p["returnDeltaPctPoints"] > 1e-8 for p in pairs), "returnWorsened": sum(p["returnDeltaPctPoints"] < -1e-8 for p in pairs),
                       "unchangedResults": sum(p["sameResult"] for p in pairs), "extraFills": sum(p["extraFills"] for p in pairs),
                       "extraCostsKrw": sum(p["extraCostsKrw"] for p in pairs)})
        record["passes"] = passes(record)
        records.append(record)
    conditions, condition_records = json.loads(conditions_path.read_text()), []
    for stage in ("validation", "confirmation", "earlier"):
        relevant = [r for r in records if r["stage"] == stage and r["diagnostic"] in ("primary", "extra25", "earlier")]
        windows = sorted([w for r in relevant for w in r["windows"]], key=lambda w: w["start"])
        baseline = sorted([w for r in relevant for w in r["baseWindows"]], key=lambda w: w["start"])
        for threshold in (.25, .30, .35):
            if stage == "earlier":
                path = cfg / f"earlier-{int(threshold * 100)}-options.json"
                sources.add(path)
                starts = json.loads(path.read_text())["starts"]
            else:
                starts = conditions[stage][str(threshold)]
            subset = [w for w in windows if w["startState"]["kospiVol20"] >= threshold]
            base_subset = [w for w in baseline if w["startState"]["kospiVol20"] >= threshold]
            if [w["start"] for w in subset] != starts or [w["start"] for w in base_subset] != starts:
                raise ValueError("조건별 고정 시작일 누락·중복")
            row = {"stage": stage, "threshold": threshold, "baseAll": summarize(base_subset), "baseNonoverlapping": summarize(nonoverlapping(base_subset)),
                   "all": summarize(subset), "nonoverlapping": summarize(nonoverlapping(subset)), "windows": subset}
            row["passes"] = bool(subset) and passes(row)
            condition_records.append(row)
    write = lambda name, value: (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    write("all-diagnostics.json", records)
    write("conditions.json", condition_records)
    for name, rows, keys in (("all-diagnostics.csv", records, ("stage", "diagnostic", "slippageBps", "seed", "rebalanceOffsetBars", "reused", "passes", "failureToSuccess", "successToFailure", "returnImproved", "returnWorsened", "unchangedResults", "extraFills", "extraCostsKrw")),
                             ("conditions.csv", condition_records, ("stage", "threshold", "passes"))):
        flat = [{k: r[k] for k in keys} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in rows]
        with (destination / name).open("w") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows(flat)
    write("nonoverlapping-diagnostics.json", [{k: v for k, v in r.items() if k not in ("windows", "baseWindows", "paired")} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records + condition_records])
    write("paired-accounts.json", [{k: r[k] for k in ("directory", "stage", "diagnostic", "slippageBps", "seed", "rebalanceOffsetBars", "reused", "paired")} for r in records])
    write("affected-action-accounts.json", affected)
    write("unclosed-accounts.json", unclosed)
    write("unclosed-volume-audit.json", maturity_volume_audit(unclosed))
    code = [Path(__file__), Path(__file__).with_name("build_target_retry_evidence.py"), Path(__file__).with_name("build_account_stop_evidence.py"),
            Path(__file__).with_name("build_execution_evidence.py"), Path(__file__).with_name("analyze_context.py"), Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml")]
    code += [Path("tests/unit") / f"{name}.test.ts" for name in ("rank-retention-quarter", "target-retry-quarter", "quarter-research", "uncertain-history-quarter", "confirmed-entry-quarter", "recovery-quarter", "cross-sectional-momentum")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "2141fe9", "newExperiments": 20,
                "newAccounts": sum(r["all"]["count"] for r in records if not r["reused"]), "reusedCandidateAccounts": sum(r["all"]["count"] for r in records if r["reused"]),
                "baselineAccounts": sum(r["baseAll"]["count"] for r in records),
                "executionCostAndCurrentThresholdsPassed": all(r["passes"] for r in records if r["diagnostic"] in ("primary", "execution", "cost"))
                    and all(r["passes"] for r in condition_records if r["stage"] != "earlier"),
                "developmentAndEarlierPassed": all(r["passes"] for r in records if r["diagnostic"] in ("development", "earlier")),
                "files": files, "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    write("manifest.json", manifest)
    write("evidence-manifest.json", {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedCandidateAccounts", "baselineAccounts", "executionCostAndCurrentThresholdsPassed", "developmentAndEarlierPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
