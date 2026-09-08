"""고정한 보유 유지 규칙을 같은 회전 주기의 기존 계좌와 대조한다."""

import argparse
import csv
import hashlib
import json
from pathlib import Path

from analyze_context import nonoverlapping, summarize
from build_account_stop_evidence import digest, verify
from build_execution_evidence import passes
from build_target_retry_evidence import audit
from build_target_retry_neighbors import trade_path


def build(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    cfg = Path(__file__).parent / "configs"
    experiments_path = cfg / "rank-retention-experiments.json"
    protocol = Path("docs/research/kr-current-quarter-rank-retention-protocol.md")
    input_path = root / "expanded/stock-200-verified-input.json.gz"
    experiments = json.loads(experiments_path.read_text())
    if len(experiments) != 6 or {(e["rebalanceBars"], e["stage"]) for e in experiments} != {(b, s) for b in (15, 20, 25) for s in ("validation", "confirmation")}:
        raise ValueError("고정한 세 회전 주기·두 단계가 누락되거나 중복됐습니다")
    records, files, affected, cases = [], [], [], []
    sources = {experiments_path, protocol, input_path}
    for e in experiments:
        bars, stage = e["rebalanceBars"], e["stage"]
        candidate_path, baseline_path, options_path = cfg / e["selection"], cfg / e["baselineSelection"], cfg / e["options"]
        candidate, baseline_candidate = json.loads(candidate_path.read_text()), json.loads(baseline_path.read_text())
        expected = {"id": f"rank-retention-{bars}", "strategyId": "rank-retention-momentum", "topN": 5, "rebalanceBars": bars,
                    "parameters": {"formationDays": 20, "skipDays": 0, "topN": 5, "retentionRank": 10}}
        original = {"id": "momentum-20-5-monthly" if bars == 20 else f"target-retry-neighbor-rebalance{bars}",
                    "strategyId": "cross-sectional-momentum", "topN": 5, "rebalanceBars": bars,
                    "parameters": {"formationDays": 20, "skipDays": 0, "topN": 5}}
        baseline = f"target-retry/seed204-offset0-{stage}" if bars == 20 else f"target-retry-neighbors/rebalance{bars}-{stage}"
        if (candidate != [expected] or baseline_candidate != [original] or e["baseline"] != baseline
                or e["options"] != f"target-retry-seed204-offset0-{stage}-options.json" or e["input"] != str(input_path.relative_to(root))
                or e["slippageBps"] != 5 or e["seed"] != 204):
            raise ValueError("보유 유지 규칙 이외의 고정 설정이 달라졌습니다")
        options = json.loads(options_path.read_text())
        old, checked = verify(root, baseline, original, stage, options_path, input_path, 15, options["starts"],
                              strategy_version="2.2.1+history-reset.1+target-retry.1")
        files.extend(checked)
        windows, checked = verify(root, e["directory"], expected, stage, options_path, input_path, 15, options["starts"],
                                  strategy_version="0.1.0+history-reset.1+target-retry.1",
                                  expected_parameters=expected["parameters"] | {"absoluteMomentumFilter": True})
        files.extend(checked)
        sources.update((candidate_path, baseline_path, options_path))
        pairs = []
        for w in windows:
            path = root / e["directory"] / f'{expected["id"]}__{w["start"]}.json'
            base_path = root / baseline / f'{original["id"]}__{w["start"]}.json'
            run, base = json.loads(path.read_text()), json.loads(base_path.read_text())
            pair = audit(run, base, same_strategy=False)
            if run["result"]["metrics"]["maxConcurrentPositions"] > 5:
                raise ValueError("다섯 종목 보유 상한을 초과했습니다")
            def first_buys(result):
                buys = [f for f in result["fills"] if f["side"] == "BUY"]
                return [f for f in buys if f["tsMs"] == buys[0]["tsMs"]] if buys else []
            if first_buys(run["result"]) != first_buys(base["result"]):
                raise ValueError("현금 시작의 최초 매수 체결이 기존 전략과 다릅니다")
            pairs.append(pair | {"sameResult": run["result"] == base["result"]})
            if w["start"] == "2024-09-02":
                cases.append({"rebalanceBars": bars, "stage": stage, "paired": pair,
                              "base": trade_path(base_path), "retention": trade_path(path)})
            if w["affectedActions"]:
                affected.append({"rebalanceBars": bars, "stage": stage, "file": str(path), "sha256": digest(path)}
                                | {k: w[k] for k in ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "affectedActions")})
        record = {"rebalanceBars": bars, "stage": stage, "candidate": expected, "baselineCandidate": original,
                  "baseAll": summarize(old), "baseNonoverlapping": summarize(nonoverlapping(old)),
                  "all": summarize(windows), "nonoverlapping": summarize(nonoverlapping(windows)), "windows": windows, "paired": pairs,
                  "failureToSuccess": sum(not p["baseTargetReached"] and p["targetReached"] for p in pairs),
                  "successToFailure": sum(p["baseTargetReached"] and not p["targetReached"] for p in pairs),
                  "returnImproved": sum(p["returnDeltaPctPoints"] > 1e-8 for p in pairs), "returnWorsened": sum(p["returnDeltaPctPoints"] < -1e-8 for p in pairs),
                  "unchangedResults": sum(p["sameResult"] for p in pairs), "extraFills": sum(p["extraFills"] for p in pairs),
                  "extraCostsKrw": sum(p["extraCostsKrw"] for p in pairs)}
        record["passes"] = passes(record)
        records.append(record)
    write = lambda name, value: (destination / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    write("all-results.json", records)
    fields = ("rebalanceBars", "stage", "passes", "failureToSuccess", "successToFailure", "returnImproved", "returnWorsened", "unchangedResults", "extraFills", "extraCostsKrw")
    flat = [{k: r[k] for k in fields} | r["all"] | {f"nonoverlapping_{k}": v for k, v in r["nonoverlapping"].items()} for r in records]
    with (destination / "all-summaries.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(flat[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(flat)
    write("nonoverlapping-accounts.json", [{k: v for k, v in r.items() if k not in ("windows", "paired")} | {
        "windows": [{k: w[k] for k in ("start", "end", "returnPct", "drawdownPct", "closed", "targetReached", "riskEvents", "affectedActions")}
                    for w in nonoverlapping(r["windows"])]} for r in records])
    write("paired-accounts.json", [{k: r[k] for k in ("rebalanceBars", "stage", "paired")} for r in records])
    write("affected-action-accounts.json", affected)
    write("motivation-case-audit.json", cases)
    code = [Path(__file__), Path(__file__).with_name("build_target_retry_neighbors.py"), Path(__file__).with_name("build_target_retry_evidence.py"), Path(__file__).with_name("build_account_stop_evidence.py"),
            Path(__file__).with_name("build_execution_evidence.py"), Path(__file__).with_name("analyze_context.py"), Path(__file__).with_name("prepare_entry_dates.py"), Path("pnpm-lock.yaml")]
    code += [Path("tests/unit") / f"{name}.test.ts" for name in ("rank-retention-quarter", "target-retry-quarter", "quarter-research", "uncertain-history-quarter", "confirmed-entry-quarter", "recovery-quarter", "cross-sectional-momentum")]
    code += list(Path(__file__).parent.glob("*.ts")) + list(Path("src/server/modules/backtest/domain").glob("*.ts")) + list(Path("src/server/modules/strategy/strategies").rglob("*.ts"))
    manifest = {"asof": "2026-09-08", "baseCommit": "ed86140", "newExperiments": 6,
                "newAccounts": sum(r["all"]["count"] for r in records), "reusedAccounts": sum(r["baseAll"]["count"] for r in records),
                "allSettingsPassed": all(r["passes"] for r in records), "files": files,
                "sourceSha256": {str(p): digest(p) for p in sorted(sources)}, "codeSha256": {str(p): digest(p) for p in sorted(set(code))}}
    write("manifest.json", manifest)
    write("evidence-manifest.json", {k: v for k, v in manifest.items() if k != "files"} | {"manifestSha256": digest(destination / "manifest.json"),
        "resultSetSha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    print(json.dumps({k: manifest[k] for k in ("newExperiments", "newAccounts", "reusedAccounts", "allSettingsPassed")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build(args.root, args.destination)
