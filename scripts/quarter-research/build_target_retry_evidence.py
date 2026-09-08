"""실제 목표 미달 뒤 재개의 원본 현금·위험 경계·같은 날짜 성과를 대조한다."""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify
from build_execution_evidence import passes


def close(a, b):
    return math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-6)


def audit(run, base, same_strategy=True):
    if run["risk"] != base["risk"] | {"resumeAfterMissedTarget": True}:
        raise ValueError("재개 이외의 위험 설정이 달라졌습니다")
    points, fills = run["result"]["equityPoints"], run["result"]["fills"]
    if ([p["tsMs"] for p in points] != [p["tsMs"] for p in base["result"]["equityPoints"]]
            or run["summary"]["startState"] != base["summary"]["startState"]):
        raise ValueError("재개가 원래 시작 조건·평가 기간을 바꿨습니다")
    if any(f["tsMs"] > points[-1]["tsMs"] for f in fills):
        raise ValueError("원래 계좌 만기 이후의 체결")
    events = run["summary"]["riskEvents"]
    resumed = [e for e in events if e["reason"] == "실제 목표 미달 후 재개"]
    if same_strategy and not resumed and run["result"] != base["result"]:
        raise ValueError("재개하지 않은 계좌의 매매 결과가 달라졌습니다")
    if same_strategy and resumed:
        first_ts = int(datetime.fromisoformat(resumed[0]["date"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
        for key in ("fills", "equityPoints"):
            if [v for v in run["result"][key] if v["tsMs"] <= first_ts] != [v for v in base["result"][key] if v["tsMs"] <= first_ts]:
                raise ValueError("최초 재개 판단 전의 현금·체결 경로가 달라졌습니다")
    peak = 100_000_000
    drawdown = 0
    for point in points:
        peak = max(peak, point["equity"])
        drawdown = min(drawdown, (point["equity"] / peak - 1) * 100)
    if not close(drawdown, run["summary"]["drawdownPct"]):
        raise ValueError("원래 계좌 최고점을 유지해 재계산한 낙폭과 불일치")
    for field, metric in (("commission", "totalCommission"), ("tax", "totalTax"), ("slippageCost", "totalSlippage")):
        if not close(sum(f[field] for f in fills), run["result"]["metrics"][metric]):
            raise ValueError("개별 체결로 재계산한 비용과 불일치")
    rows, state, target_ts = [], None, None
    for event in events:
        ts = int(datetime.fromisoformat(event["date"]).replace(tzinfo=timezone.utc).timestamp() * 1000)
        if event["reason"] == "계좌 목표 청산":
            state, target_ts = "target", ts
        elif event["reason"] in ("계좌 낙폭 중단", "3개월 만기 청산"):
            state = "blocked"
        elif event["reason"] == "실제 목표 미달 후 재개":
            if state != "target":
                raise ValueError("목표 청산 이외의 중단 뒤 재개했습니다")
            cash, positions = 100_000_000, {}
            for fill in fills:
                if fill["tsMs"] > ts:
                    continue
                sign = 1 if fill["side"] == "BUY" else -1
                positions[fill["symbol"]] = positions.get(fill["symbol"], 0) + sign * fill["quantity"]
                cash -= sign * fill["grossAmount"] + fill["commission"] + fill["tax"]
            point = next(p for p in points if p["tsMs"] == ts)
            peak = max(100_000_000, *(p["equity"] for p in points if p["tsMs"] <= ts))
            if (any(abs(q) > 1e-8 for q in positions.values()) or not close(cash, event["equity"])
                    or not close(cash, point["equity"]) or (cash / 100_000_000 - 1) * 100 >= 10
                    or cash <= peak * .85 or ts >= run["risk"]["lastSignalTsMs"]
                    or any(f["side"] == "BUY" and target_ts < f["tsMs"] <= ts for f in fills)):
                raise ValueError("재개의 현금·전량 청산·실제 목표·원래 낙폭·만기·청산 중 진입 위반")
            next_buy = next((f["tsMs"] for f in fills if f["side"] == "BUY" and f["tsMs"] > ts), None)
            rows.append({"date": event["date"], "cash": cash, "realizedReturnPct": (cash / 100_000_000 - 1) * 100,
                         "originalPeak": peak, "drawdownPct": (cash / peak - 1) * 100,
                         "nextBuy": datetime.fromtimestamp(next_buy / 1000, timezone.utc).strftime("%Y-%m-%d") if next_buy else None})
            state = "active"
        else:
            raise ValueError("알 수 없는 위험 사건")
    costs = lambda r: sum(r["result"]["metrics"][k] for k in ("totalCommission", "totalTax", "totalSlippage"))
    return {"start": run["summary"]["start"], "end": run["summary"]["end"], "resumptions": rows,
            "baseReturnPct": base["summary"]["returnPct"], "returnPct": run["summary"]["returnPct"],
            "returnDeltaPctPoints": run["summary"]["returnPct"] - base["summary"]["returnPct"],
            "baseDrawdownPct": base["summary"]["drawdownPct"], "drawdownPct": run["summary"]["drawdownPct"],
            "baseTargetReached": base["summary"]["targetReached"], "targetReached": run["summary"]["targetReached"],
            "extraFills": len(fills) - len(base["result"]["fills"]), "extraCostsKrw": costs(run) - costs(base),
            "closed": run["summary"]["closed"], "riskEvents": events}


def build(root, destination, include_conditional):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path, candidate_path = cfg / "target-retry-experiments.json", cfg / "account-stop-candidate.json"
    protocol = Path("docs/research/kr-current-quarter-target-retry-protocol.md")
    input_path = root / "expanded/stock-200-verified-input.json.gz"
    experiments, candidate = json.loads(experiments_path.read_text()), json.loads(candidate_path.read_text())[0]
    expected = {(phase, seed, offset, stage) for phase, settings in (
        ("primary", ((204, 0), (204, 2), (204, 4))), ("conditional", ((204, 1), (204, 3), (205, 0), (206, 0))))
        for seed, offset in settings for stage in ("validation", "confirmation")}
    if len(experiments) != 14 or {(e["phase"], e["seed"], e["rebalanceOffsetBars"], e["stage"]) for e in experiments} != expected:
        raise ValueError("실행 전 고정한 실험 조합의 누락·중복")
    sources, files, records = {experiments_path, candidate_path, input_path, protocol}, [], []
    for e in experiments:
        if e["phase"] == "conditional" and not include_conditional:
            continue
        if e["phase"] == "conditional" and (sum(r["phase"] == "primary" for r in records) != 6
                or not all(r["passes"] for r in records if r["phase"] == "primary")):
            raise ValueError("초기 비교가 통과하기 전에 후속 실행을 집계할 수 없습니다")
        options_path, baseline_options = cfg / e["options"], cfg / e["baselineOptions"]
        options, original = json.loads(options_path.read_text()), json.loads(baseline_options.read_text())
        if (options != original | {"resumeAfterMissedTarget": True} or e["input"] != str(input_path.relative_to(root))
                or e["selection"] != candidate_path.name or e["slippageBps"] != 5
                or original.get("rebalanceOffsetBars", 0) != e["rebalanceOffsetBars"]):
            raise ValueError("재개 정책 이외의 고정 설정이 달라졌습니다")
        sources.update((options_path, baseline_options))
        base_windows, checked = verify(root, e["baseline"], candidate, e["stage"], baseline_options, input_path, 15, original["starts"], seed=e["seed"])
        files.extend(checked)
        windows, checked = verify(root, e["directory"], candidate, e["stage"], options_path, input_path, 15, options["starts"],
                                  seed=e["seed"], strategy_version="2.2.1+history-reset.1+target-retry.1")
        files.extend(checked)
        pairs = []
        for w in windows:
            filename = f'{candidate["id"]}__{w["start"]}.json'
            pairs.append(audit(json.loads((root / e["directory"] / filename).read_text()), json.loads((root / e["baseline"] / filename).read_text())))
        record = {k: e[k] for k in ("phase", "directory", "baseline", "stage", "seed", "rebalanceOffsetBars")}
        record.update({"baseAll": summarize(base_windows), "baseNonoverlapping": summarize(nonoverlapping(base_windows)),
                       "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows, "paired": pairs,
                       "resumedAccounts": sum(bool(p["resumptions"]) for p in pairs), "resumptions": sum(len(p["resumptions"]) for p in pairs),
                       "failureToSuccess": sum(not p["baseTargetReached"] and p["targetReached"] for p in pairs),
                       "successToFailure": sum(p["baseTargetReached"] and not p["targetReached"] for p in pairs),
                       "returnImproved": sum(p["returnDeltaPctPoints"] > 1e-8 for p in pairs),
                       "returnWorsened": sum(p["returnDeltaPctPoints"] < -1e-8 for p in pairs),
                       "extraFills": sum(p["extraFills"] for p in pairs), "extraCostsKrw": sum(p["extraCostsKrw"] for p in pairs)})
        record["passes"] = passes(record)
        records.append(record)
    write = lambda filename, value: (destination / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    write("all-results.json", records)
    keys = ("phase", "stage", "seed", "rebalanceOffsetBars", "passes", "resumedAccounts", "resumptions", "failureToSuccess", "successToFailure",
            "returnImproved", "returnWorsened", "extraFills", "extraCostsKrw")
    flat = [{k: r[k] for k in keys} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    fields = ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")
    write("nonoverlapping-accounts.json", [{k: v for k, v in r.items() if k not in ("windows", "paired")} | {
        "windows": [{k: w[k] for k in fields} for w in nonoverlapping(r["windows"])]} for r in records])
    write("paired-accounts.json", [{k: r[k] for k in ("phase", "stage", "seed", "rebalanceOffsetBars", "paired")} for r in records])
    code = [Path(__file__), Path(__file__).with_name("build_account_stop_evidence.py"), Path(__file__).with_name("build_execution_evidence.py"),
            Path(__file__).with_name("analyze_context.py"), Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml"),
            Path("tests/unit/target-retry-quarter.test.ts"), Path("tests/unit/quarter-research.test.ts")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "97ba981", "newExperiments": len(records), "newAccounts": sum(r["all"]["count"] for r in records),
                "reusedAccounts": sum(r["baseAll"]["count"] for r in records), "primaryPassed": all(r["passes"] for r in records if r["phase"] == "primary"),
                "conditionalExecuted": include_conditional, "allSettingsPassed": all(r["passes"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    write("manifest.json", manifest)
    write("evidence-manifest.json", {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedAccounts", "primaryPassed", "conditionalExecuted", "allSettingsPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--include-conditional", action="store_true")
    args = parser.parse_args()
    build(args.root, args.destination, args.include_conditional)
